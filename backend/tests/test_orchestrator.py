import asyncio
from typing import Any

import pytest

from app.core.config import settings
from app.services import certspotter_service, orchestrator


async def _no_cache_get(key: str):
    return None


async def _no_cache_set(*args, **kwargs):
    return None


async def _missing_subfinder(target):
    raise RuntimeError("Subfinder CLI is unavailable on PATH")


async def _failed_certspotter(target, client=None):
    raise RuntimeError("Cert Spotter is unavailable")


@pytest.mark.asyncio
async def test_partial_failure(monkeypatch):
    async def ok_shodan(target, client=None):
        return {"ports": [80], "vulns": []}

    async def fail_crtsh(target, client=None):
        raise RuntimeError("crt.sh: Timeout")

    async def ok_whois(target):
        return {"registrar": "Example"}

    monkeypatch.setattr(orchestrator.shodan_service, "lookup", ok_shodan)
    monkeypatch.setattr(orchestrator.crtsh_service, "lookup", fail_crtsh)
    monkeypatch.setattr(certspotter_service, "lookup", _failed_certspotter)
    monkeypatch.setattr(orchestrator.subfinder_service, "lookup", _missing_subfinder)
    monkeypatch.setattr(orchestrator.whois_service, "lookup", ok_whois)
    monkeypatch.setattr(orchestrator.cache_mod, "cache_get_async", _no_cache_get)
    monkeypatch.setattr(orchestrator.cache_mod, "cache_set_async", _no_cache_set)

    results, errors = await orchestrator.gather_results("example.com", force=True)
    assert "shodan" in results and "whois" in results
    assert any(e["source"] == "crtsh" for e in errors)

    payload = await orchestrator.run_scan("example.com", "u1", force=True)
    assert payload["status"] == "partial"
    assert payload["risk_score"] is not None


@pytest.mark.asyncio
async def test_crtsh_failure_uses_subfinder_and_preserves_crtsh_error(monkeypatch):
    async def ok_shodan(target, client=None):
        return {"ports": [], "vulns": []}

    async def ok_whois(target):
        return {"registrar": "Example"}

    async def fail_crtsh(target, client=None):
        raise RuntimeError("crt.sh: HTTP 503 unavailable")

    async def ok_subfinder(target):
        return {
            "domain": target,
            "count": 1,
            "subdomains": [
                {
                    "subdomain": "www.example.com",
                    "issuer": "",
                    "not_before": "",
                    "not_after": "",
                }
            ],
        }

    monkeypatch.setattr(orchestrator.shodan_service, "lookup", ok_shodan)
    monkeypatch.setattr(orchestrator.whois_service, "lookup", ok_whois)
    monkeypatch.setattr(orchestrator.crtsh_service, "lookup", fail_crtsh)
    monkeypatch.setattr(orchestrator.subfinder_service, "lookup", ok_subfinder)
    monkeypatch.setattr(certspotter_service, "lookup", _failed_certspotter)
    monkeypatch.setattr(orchestrator.cache_mod, "cache_get_async", _no_cache_get)
    monkeypatch.setattr(orchestrator.cache_mod, "cache_set_async", _no_cache_set)

    results, errors = await orchestrator.gather_results("example.com", force=True)

    assert results["crtsh"]["subdomains"][0]["subdomain"] == "www.example.com"
    # Cert Spotter failed but Subfinder recovered → crtsh result present,
    # no crtsh/subfinder errors (the crt.sh error is preserved in logs only).
    assert not any(error["source"] in ("crtsh", "subfinder") for error in errors)


@pytest.mark.asyncio
async def test_subfinder_failure_is_reported_alongside_crtsh_error(monkeypatch):
    async def ok_shodan(target, client=None):
        return {"ports": [], "vulns": []}

    async def ok_whois(target):
        return {"registrar": "Example"}

    async def fail_crtsh(target, client=None):
        raise RuntimeError("crt.sh unavailable")

    async def fail_subfinder(target):
        raise RuntimeError("Subfinder CLI is unavailable on PATH")

    monkeypatch.setattr(orchestrator.shodan_service, "lookup", ok_shodan)
    monkeypatch.setattr(orchestrator.whois_service, "lookup", ok_whois)
    monkeypatch.setattr(orchestrator.crtsh_service, "lookup", fail_crtsh)
    monkeypatch.setattr(certspotter_service, "lookup", _failed_certspotter)
    monkeypatch.setattr(orchestrator.subfinder_service, "lookup", fail_subfinder)
    monkeypatch.setattr(orchestrator.cache_mod, "cache_get_async", _no_cache_get)
    monkeypatch.setattr(orchestrator.cache_mod, "cache_set_async", _no_cache_set)

    results, errors = await orchestrator.gather_results("example.com", force=True)

    assert "crtsh" not in results
    # crt.sh down + both passive fallbacks down → single aggregated crtsh error
    # naming every failed fallback (Cert Spotter first, then Subfinder).
    assert {error["source"] for error in errors} == {"crtsh"}
    msg = next(error["message"] for error in errors if error["source"] == "crtsh")
    assert "crt.sh unavailable" in msg
    assert "Cert Spotter" in msg
    assert "Subfinder" in msg


# --- DNS: the fifth source ---------------------------------------------------
#
# dns_service.lookup itself is tested by test_dns_service.py. What is pinned
# HERE is the scan-path contract: the job is bounded, cached under its own key,
# isolated from the other sources, and skipped for a target it does not apply
# to. The conftest autouse fixture replaces the orchestrator's dns_service with
# a success stub, so each test that needs a specific outcome swaps in its own.


def _cache() -> tuple[dict[str, Any], Any, Any]:
    """A dict-backed cache plus the same async get/set surface."""
    store: dict[str, Any] = {}

    async def _get(key: str) -> Any:
        return store.get(key)

    async def _set(key: str, value: Any, ttl: int) -> None:
        store[key] = value

    return store, _get, _set


def _stub_service(**lookups: Any) -> Any:
    """A module-shaped stand-in for one service with named lookups."""
    from types import SimpleNamespace

    return SimpleNamespace(**lookups)


@pytest.mark.asyncio
async def test_dns_failure_is_partial_and_never_takes_the_others_down(monkeypatch):
    """The partial-failure path the TODO requires, with DNS as the dead source."""

    async def ok_shodan(target, client=None):
        return {"ports": [80], "vulns": []}

    async def ok_crtsh(target, client=None):
        return {"domain": target, "count": 0, "subdomains": []}

    async def ok_whois(target):
        return {"registrar": "Example"}

    async def dns_down(target):
        raise RuntimeError("dns: timed out after 10s — retry with Re-scan")

    monkeypatch.setattr(orchestrator.shodan_service, "lookup", ok_shodan)
    monkeypatch.setattr(orchestrator.crtsh_service, "lookup", ok_crtsh)
    monkeypatch.setattr(orchestrator.whois_service, "lookup", ok_whois)
    monkeypatch.setattr(orchestrator, "dns_service", _stub_service(lookup=dns_down))
    _store, _get, _set = _cache()
    monkeypatch.setattr(orchestrator.cache_mod, "cache_get_async", _get)
    monkeypatch.setattr(orchestrator.cache_mod, "cache_set_async", _set)

    results, errors = await orchestrator.gather_results("example.com", force=True)

    # The other three sources still rendered — one dead source never takes the
    # scan down (AGENTS.md §5.4).
    assert set(results) >= {"shodan", "crtsh", "whois"}
    assert "dns" not in results
    assert [error["source"] for error in errors] == ["dns"]

    payload = await orchestrator.run_scan("example.com", "u1", force=True)
    assert payload["status"] == "partial"
    assert payload["risk_score"] is not None


@pytest.mark.asyncio
async def test_dns_block_lands_in_the_snapshot_with_its_own_errors(monkeypatch):
    """A per-type failure lives inside the block; it is not a dead source.

    Per-type isolation is dns_service's job, so an unanswered record type
    never reaches the orchestrator's errors[]: the block carries its own
    `errors` list and the scan stays `completed`.
    """

    async def ok_shodan(target, client=None):
        return {"ports": [80], "vulns": []}

    async def ok_crtsh(target, client=None):
        return {"domain": target, "count": 0, "subdomains": []}

    async def ok_whois(target):
        return {"registrar": "Example"}

    async def dns_partial(target):
        return {
            "source": "DNS",
            "domain": target,
            "records": {"A": [{"value": "93.184.216.34", "ttl": 300}]},
            "counts_truncated": False,
            "missing": ["MX"],
            "errors": [{"type": "AAAA", "message": "query timed out"}],
            "note": "AAAA could not be queried; counts are partial evidence.",
        }

    monkeypatch.setattr(orchestrator.shodan_service, "lookup", ok_shodan)
    monkeypatch.setattr(orchestrator.crtsh_service, "lookup", ok_crtsh)
    monkeypatch.setattr(orchestrator.whois_service, "lookup", ok_whois)
    monkeypatch.setattr(orchestrator, "dns_service", _stub_service(lookup=dns_partial))
    _store, _get, _set = _cache()
    monkeypatch.setattr(orchestrator.cache_mod, "cache_get_async", _get)
    monkeypatch.setattr(orchestrator.cache_mod, "cache_set_async", _set)

    payload = await orchestrator.run_scan("example.com", "u1", force=True)

    dns = payload["results"]["dns"]
    assert dns["records"]["A"][0]["value"] == "93.184.216.34"
    assert dns["missing"] == ["MX"]
    assert dns["errors"] == [{"type": "AAAA", "message": "query timed out"}]
    assert payload["status"] == "completed"
    assert payload["errors"] == []


@pytest.mark.asyncio
async def test_dns_is_cached_under_its_own_key_and_reused(monkeypatch):
    """Same cache discipline as every other source: a hit costs zero network."""
    calls: list[str] = []

    async def ok_shodan(target, client=None):
        return {"ports": [], "vulns": []}

    async def ok_crtsh(target, client=None):
        return {"domain": target, "count": 0, "subdomains": []}

    async def ok_whois(target):
        return {"registrar": "Example"}

    async def counting_dns(target):
        calls.append(target)
        return {"source": "DNS", "domain": target, "records": {"A": []}}

    monkeypatch.setattr(orchestrator.shodan_service, "lookup", ok_shodan)
    monkeypatch.setattr(orchestrator.crtsh_service, "lookup", ok_crtsh)
    monkeypatch.setattr(orchestrator.whois_service, "lookup", ok_whois)
    monkeypatch.setattr(orchestrator, "dns_service", _stub_service(lookup=counting_dns))
    store, _get, _set = _cache()
    monkeypatch.setattr(orchestrator.cache_mod, "cache_get_async", _get)
    monkeypatch.setattr(orchestrator.cache_mod, "cache_set_async", _set)

    await orchestrator.gather_results("example.com", force=True)
    assert calls == ["example.com"]
    assert "dns:example.com" in store, "the DNS block is cached like any source"

    await orchestrator.gather_results("example.com", force=False)
    assert calls == ["example.com"], "a cache hit must not query the resolver again"


@pytest.mark.asyncio
async def test_dns_timeout_is_bounded_by_scan_timeout_dns(monkeypatch):
    """The DNS job is bounded like every other source (AGENTS.md §5.5)."""
    monkeypatch.setattr(settings, "scan_timeout_dns", 1)

    async def ok_shodan(target, client=None):
        return {"ports": [], "vulns": []}

    async def ok_crtsh(target, client=None):
        return {"domain": target, "count": 0, "subdomains": []}

    async def ok_whois(target):
        return {"registrar": "Example"}

    async def dns_hangs(target):
        await asyncio.sleep(30)
        return {"source": "DNS", "records": {}}

    monkeypatch.setattr(orchestrator.shodan_service, "lookup", ok_shodan)
    monkeypatch.setattr(orchestrator.crtsh_service, "lookup", ok_crtsh)
    monkeypatch.setattr(orchestrator.whois_service, "lookup", ok_whois)
    monkeypatch.setattr(orchestrator, "dns_service", _stub_service(lookup=dns_hangs))
    _store, _get, _set = _cache()
    monkeypatch.setattr(orchestrator.cache_mod, "cache_get_async", _get)
    monkeypatch.setattr(orchestrator.cache_mod, "cache_set_async", _set)

    results, errors = await orchestrator.gather_results("example.com", force=True)

    assert "dns" not in results
    dns_error = next(e for e in errors if e["source"] == "dns")
    assert "timed out after 1s" in dns_error["message"]
    assert set(results) >= {"shodan", "crtsh", "whois"}


@pytest.mark.asyncio
async def test_ip_literal_target_never_runs_the_dns_source(monkeypatch):
    """An address has no MX records; an IP scan must not earn a DNS error."""
    calls: list[str] = []

    async def counting_dns(target):
        calls.append(target)
        return {"source": "DNS", "records": {}}

    async def ok_shodan(target, client=None):
        return {"ports": [80], "vulns": []}

    async def ok_crtsh(target, client=None):
        return {"domain": target, "count": 0, "subdomains": []}

    async def ok_whois(target):
        return {"registrar": "Example"}

    monkeypatch.setattr(orchestrator.shodan_service, "lookup", ok_shodan)
    monkeypatch.setattr(orchestrator.crtsh_service, "lookup", ok_crtsh)
    monkeypatch.setattr(orchestrator.whois_service, "lookup", ok_whois)
    monkeypatch.setattr(orchestrator, "dns_service", _stub_service(lookup=counting_dns))
    _store, _get, _set = _cache()
    monkeypatch.setattr(orchestrator.cache_mod, "cache_get_async", _get)
    monkeypatch.setattr(orchestrator.cache_mod, "cache_set_async", _set)

    results, errors = await orchestrator.gather_results("93.184.216.34", force=True)

    assert calls == [], "a DNS lookup does not apply to an IP literal"
    assert "dns" not in results
    assert not any(e["source"] == "dns" for e in errors), (
        "a skipped source is not a failed source — marking an IP scan partial "
        "for a lookup that does not apply would fabricate a failure"
    )
    assert set(results) >= {"shodan", "crtsh", "whois"}
