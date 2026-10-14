"""Tests for source_health_service and the status endpoint it backs.

What is pinned here:

  * the status vocabulary is honest — a failed probe is `unknown`, never
    `down`, and a configured-but-rejected key is `degraded`, not `unknown`;
  * the cache works: a hit serves the stored answer and runs no probes;
  * the probe never touches the network in these tests (each probe body is
    replaced), so the suite stays hermetic.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from app.core import cache as cache_mod
from app.core import rate_limit
from app.core.config import settings
from app.core.security import require_user
from app.main import create_app
from app.services import source_health_service as svc

SOURCES = ("shodan", "crtsh", "nvd", "whois", "dns")


@pytest.fixture(autouse=True)
def _reset_rate_limit() -> Iterator[None]:
    rate_limit.reset_for_tests()
    yield
    rate_limit.reset_for_tests()


def _cache() -> tuple[dict[str, Any], Any, Any]:
    """A dict-backed cache plus the async get/set surface, with TTL recorded."""
    store: dict[str, Any] = {}
    writes: list[tuple[str, int]] = []

    async def _get(key: str) -> Any:
        return store.get(key)

    async def _set(key: str, value: Any, ttl: int) -> None:
        store[key] = value
        writes.append((key, ttl))

    return store, _get, _set


def _patch(monkeypatch: pytest.MonkeyPatch, **lookups: Any) -> None:
    monkeypatch.setattr(svc, "_probe_http", lookups["http"])
    monkeypatch.setattr(svc, "_probe_whois", lookups["whois"])
    monkeypatch.setattr(svc, "_probe_dns", lookups["dns"])


# --- the vocabulary ----------------------------------------------------------


def test_http_status_mapping_is_honest():
    """An answer is an answer: a rejected key is degraded, not unknown."""
    assert svc._http_result("x", 200)["status"] == "ok"
    assert svc._http_result("x", 204)["status"] == "ok"
    for code in (401, 403, 429, 500, 502, 503, 404):
        status = svc._http_result("x", code)
        assert status["status"] == "degraded", code
        assert str(code) in status["detail"], code


async def test_probe_failure_is_unknown_not_down(monkeypatch):
    """A timeout says nothing about the source, so nothing is claimed."""

    async def _boom(client, source, url, params):
        raise httpx.ConnectTimeout("timed out")

    async def _whois():
        raise TimeoutError("whois timed out")

    async def _dns():
        raise TimeoutError("dns timed out")

    _patch(monkeypatch, http=_boom, whois=_whois, dns=_dns)
    _store, _get, _set = _cache()
    monkeypatch.setattr(cache_mod, "cache_get_async", _get)
    monkeypatch.setattr(cache_mod, "cache_set_async", _set)

    probes = await svc._probe_all()

    assert set(probes) == set(SOURCES)
    for source, result in probes.items():
        assert result["status"] == "unknown", source
        assert result["detail"], source
    # The payload itself carries the disclaimer, so a client rendering the
    # status cannot quietly turn `unknown` into "down".
    assert "unknown is not evidence that a source is down" in svc.PROBE_NOTE
    # No probe result may claim a status outside the vocabulary.
    assert all(p["status"] in {"ok", "degraded", "unknown"} for p in probes.values())


async def test_unconfigured_source_is_unknown_with_a_reason(monkeypatch):
    """A blank key is a budget decision, not an outage — and not a probe."""

    async def _boom(client, source, url, params):
        raise AssertionError("an unconfigured source must not be probed")

    async def _whois():
        return {"source": "whois", "status": "ok"}

    async def _dns():
        return {"source": "dns", "status": "ok"}

    monkeypatch.setattr(settings, "shodan_api_key", "")
    _patch(monkeypatch, http=_boom, whois=_whois, dns=_dns)

    probes = await svc._probe_all()

    assert probes["shodan"]["status"] == "unknown"
    assert "not configured" in probes["shodan"]["detail"]


async def test_dns_probe_reads_a_partial_answer_as_degraded(monkeypatch):
    """A resolver that answers some types but not all is not fully healthy."""

    async def _lookup(target: str) -> dict[str, Any]:
        return {
            "records": {"A": [{"value": "93.184.216.34", "ttl": 300}]},
            "errors": [{"type": "MX", "message": "timed out"}],
            "note": "MX could not be queried",
        }

    monkeypatch.setattr(svc.dns_service, "lookup", _lookup)

    assert (await svc._probe_dns())["status"] == "degraded"


async def test_dns_probe_with_no_records_at_all_is_degraded(monkeypatch):
    """example.com answering NXDOMAIN is a broken resolver, not a clean bill."""

    async def _lookup(target: str) -> dict[str, Any]:
        return {
            "records": {},
            "errors": [],
            "note": "example.com does not resolve: NXDOMAIN on every queried record type.",
        }

    monkeypatch.setattr(svc.dns_service, "lookup", _lookup)

    result = await svc._probe_dns()
    assert result["status"] == "degraded"
    assert "NXDOMAIN" in result["detail"]


# --- the cache ---------------------------------------------------------------


async def test_cache_hit_runs_no_probes(monkeypatch):
    """The endpoint must not spend a probe per request."""
    stored = {
        "sources": {name: {"source": name, "status": "ok"} for name in SOURCES},
        "checked_at": "2026-10-14T00:00:00+00:00",
    }

    async def _hit(key: str) -> Any:
        return stored if key == svc.CACHE_KEY else None

    async def _boom(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("a cache hit must not probe")

    monkeypatch.setattr(cache_mod, "cache_get_async", _hit)
    monkeypatch.setattr(cache_mod, "cache_set_async", _boom)
    monkeypatch.setattr(svc, "_probe_all", _boom)

    payload = await svc.source_status()

    assert payload["cached"] is True
    assert payload["checked_at"] == stored["checked_at"]
    assert set(payload["sources"]) == set(SOURCES)
    assert svc.PROBE_NOTE in payload["note"]


async def test_a_cold_cache_probes_once_and_writes_the_ttl(monkeypatch):
    calls: list[str] = []

    async def _miss(key: str) -> None:
        return None

    async def _set(key: str, value: Any, ttl: int) -> None:
        calls.append(key)

    async def _probe_all():
        return {name: {"source": name, "status": "unknown"} for name in SOURCES}

    monkeypatch.setattr(settings, "source_health_ttl_seconds", 300)
    monkeypatch.setattr(cache_mod, "cache_get_async", _miss)
    monkeypatch.setattr(cache_mod, "cache_set_async", _set)
    monkeypatch.setattr(svc, "_probe_all", _probe_all)

    payload = await svc.source_status()

    assert payload["cached"] is False
    assert calls == [svc.CACHE_KEY]
    assert payload["sources"]["crtsh"]["status"] == "unknown"


@respx.mock
async def test_live_http_probes_map_a_real_transport(monkeypatch):
    """One respx-backed pass so the httpx path itself is exercised, not just
    the status mapping: 200 -> ok, 503 -> degraded, timeout -> unknown."""
    monkeypatch.setattr(settings, "shodan_api_key", "test-key")
    respx.get("https://api.shodan.io/api-info").mock(
        return_value=httpx.Response(200, json={"plan": "dev"})
    )
    respx.get("https://crt.sh/").mock(return_value=httpx.Response(503))
    respx.get("https://services.nvd.nist.gov/rest/json/cves/2.0").mock(
        side_effect=httpx.ConnectTimeout("nvd timed out")
    )

    async def _whois():
        return {"source": "whois", "status": "ok"}

    async def _dns():
        return {"source": "dns", "status": "ok"}

    monkeypatch.setattr(svc, "_probe_whois", _whois)
    monkeypatch.setattr(svc, "_probe_dns", _dns)

    probes = await svc._probe_all()

    assert probes["shodan"] == {"source": "shodan", "status": "ok", "detail": ""}
    assert probes["crtsh"]["status"] == "degraded"
    assert "503" in probes["crtsh"]["detail"]
    assert probes["nvd"]["status"] == "unknown"
    # The whois and dns probes never reach the mocked HTTP layer.
    assert probes["whois"]["status"] == "ok"
    assert probes["dns"]["status"] == "ok"


# --- the endpoint ------------------------------------------------------------


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setattr(settings, "free_rate_limit_per_hour", 100)
    _store, _get, _set = _cache()
    monkeypatch.setattr(cache_mod, "cache_get_async", _get)
    monkeypatch.setattr(cache_mod, "cache_set_async", _set)

    probes: list[str] = []

    async def _probe_all():
        probes.append("run")
        return {name: {"source": name, "status": "ok"} for name in SOURCES}

    monkeypatch.setattr(svc, "_probe_all", _probe_all)

    app = create_app()
    app.dependency_overrides[require_user] = lambda: "user:test"
    with TestClient(app) as c:
        c.probes = probes  # type: ignore[attr-defined]
        yield c
    rate_limit.reset_for_tests()


def test_health_and_ready_stay_unauthenticated(client):
    """A keep-alive ping and a platform health check carry no session."""
    assert client.get("/health").json() == {"status": "ok"}
    assert client.get("/health").status_code == 200


def test_health_sources_requires_a_session():
    app = create_app()
    with TestClient(app) as unauthed:
        response = unauthed.get("/health/sources")
    assert response.status_code in (
        401,
        503,
    ), f"/health/sources answered {response.status_code} without a session"


def test_health_sources_returns_the_vocabulary_and_caches(client):
    first = client.get("/health/sources")
    assert first.status_code == 200
    body = first.json()
    assert body["cached"] is False
    assert set(body["sources"]) == set(SOURCES)
    for name, status in body["sources"].items():
        assert status["status"] in {"ok", "degraded", "unknown"}, name
    assert body["checked_at"]
    assert "unknown is not evidence" in body["note"]

    second = client.get("/health/sources")
    assert second.json()["cached"] is True
    assert client.probes == ["run"], "the second call must be served from cache"
