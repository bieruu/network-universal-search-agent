"""Per-service mocked tests: shodan, crt.sh, whois + orchestrator terminal states.

External network is never touched: httpx clients are faked, DNS stubbed,
and the blocking python-whois import is replaced via sys.modules.
Covers TODO Phase 4 item 1 (each service mocked).
"""

from __future__ import annotations

import asyncio
import socket
import sys
import time
import types

import httpx
import pytest
from fastapi import HTTPException

from app.core.config import settings
from app.core.security import resolve_target_ip
from app.services import (
    certspotter_service,
    crtsh_service,
    orchestrator,
    shodan_service,
    whois_service,
)


class _FakeResponse:
    def __init__(self, payload):
        self._payload = payload
        self.status_code = 200

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


class _FakeClient:
    """Minimal httpx.AsyncClient stand-in: records params, returns canned JSON."""

    def __init__(self, payload):
        self._payload = payload
        self.calls: list[dict] = []

    async def get(self, url, params=None, timeout=None):
        self.calls.append({"url": url, "params": params})
        return _FakeResponse(self._payload)


@pytest.fixture
def shodan_key(monkeypatch):
    monkeypatch.setattr(settings, "shodan_api_key", "test-key")
    return "test-key"


# --- Shodan ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_shodan_maps_host_and_truncates_banner(shodan_key):
    raw = {
        "ports": [80, 443],
        "data": [
            {
                "port": 80,
                "transport": "tcp",
                "product": "nginx",
                "version": "1.25",
                "data": "B" * 5000,  # must truncate to 2KB per AGENTS.md
            },
            {"port": 443},  # missing keys → defaults
        ],
        "vulns": {"CVE-2021-1": {}, "CVE-2022-2": {}},
        "isp": "Example ISP",
        "asn": "AS1234",
        "city": "Jakarta",
        "country_name": "Indonesia",
    }
    out = await shodan_service.lookup("1.1.1.1", client=_FakeClient(raw))
    assert out["ip"] == "1.1.1.1"
    assert out["ports"] == [80, 443]
    assert out["services"][0]["product"] == "nginx"
    assert len(out["services"][0]["banner"]) == 2048
    assert out["services"][1]["transport"] == "tcp"  # default
    assert sorted(out["vulns"]) == ["CVE-2021-1", "CVE-2022-2"]
    assert out["isp"] == "Example ISP"
    assert out["source"] == "Shodan"


@pytest.mark.asyncio
async def test_shodan_403_falls_back_to_public_internetdb(shodan_key):
    request = httpx.Request("GET", "https://api.shodan.io/shodan/host/1.1.1.1")
    denied = httpx.Response(403, request=request)

    class _SequenceClient:
        def __init__(self):
            self.responses = [
                denied,
                _FakeResponse(
                    {
                        "ports": [443, 80, 0, 65536, True],
                        "vulns": ["CVE-2025-1234", 42],
                    }
                ),
            ]
            self.calls = []

        async def get(self, url, params=None, timeout=None):
            self.calls.append({"url": url, "params": params, "timeout": timeout})
            return self.responses.pop(0)

    client = _SequenceClient()
    result = await shodan_service.lookup("1.1.1.1", client=client)

    assert result["source"] == "Shodan InternetDB"
    assert result["ip"] == "1.1.1.1"
    assert result["ports"] == [443, 80]
    assert [item["port"] for item in result["services"]] == [443, 80]
    assert result["vulns"] == ["CVE-2025-1234"]
    assert client.calls[0]["params"] == {"key": shodan_key}
    assert client.calls[1]["url"] == "https://internetdb.shodan.io/1.1.1.1"
    assert client.calls[1]["params"] is None
    assert client.calls[1]["timeout"] == settings.scan_timeout_shodan


@pytest.mark.asyncio
async def test_shodan_internetdb_404_is_empty_lookup(shodan_key):
    request = httpx.Request("GET", "https://api.shodan.io/shodan/host/1.1.1.1")
    denied = httpx.Response(403, request=request)
    not_found = httpx.Response(
        404,
        request=httpx.Request("GET", "https://internetdb.shodan.io/1.1.1.1"),
    )

    class _SequenceClient:
        def __init__(self):
            self.responses = [denied, not_found]

        async def get(self, url, params=None, timeout=None):
            return self.responses.pop(0)

    result = await shodan_service.lookup("1.1.1.1", client=_SequenceClient())

    assert result["source"] == "Shodan InternetDB"
    assert result["ports"] == []
    assert result["services"] == []
    assert result["vulns"] == []


@pytest.mark.asyncio
async def test_shodan_404_falls_back_to_internetdb(shodan_key):
    shodan_404 = httpx.Response(
        404,
        request=httpx.Request("GET", "https://api.shodan.io/shodan/host/44.228.249.3"),
    )
    internetdb = _FakeResponse({"ports": [80, 443], "vulns": ["CVE-2025-1234"]})

    class _SequenceClient:
        def __init__(self):
            self.responses = [shodan_404, internetdb]
            self.urls = []

        async def get(self, url, params=None, timeout=None):
            self.urls.append(url)
            return self.responses.pop(0)

    client = _SequenceClient()
    result = await shodan_service.lookup("44.228.249.3", client=client)

    assert result["source"] == "Shodan InternetDB"
    assert result["ports"] == [80, 443]
    assert result["vulns"] == ["CVE-2025-1234"]
    assert client.urls == [
        "https://api.shodan.io/shodan/host/44.228.249.3",
        "https://internetdb.shodan.io/44.228.249.3",
    ]


@pytest.mark.asyncio
async def test_shodan_resolves_domain_via_dns(shodan_key, monkeypatch):
    monkeypatch.setattr(socket, "gethostbyname", lambda host: "9.9.9.9")
    client = _FakeClient({"ports": [], "data": []})
    out = await shodan_service.lookup("example.com", client=client)
    assert out["ip"] == "9.9.9.9"
    assert client.calls[0]["url"].endswith("/shodan/host/9.9.9.9")
    assert client.calls[0]["params"] == {"key": "test-key"}


@pytest.mark.asyncio
async def test_shodan_no_key_raises(monkeypatch):
    monkeypatch.setattr(settings, "shodan_api_key", "")
    with pytest.raises(RuntimeError, match="SHODAN_API_KEY"):
        await shodan_service.lookup("1.1.1.1", client=_FakeClient({}))


@pytest.mark.asyncio
async def test_shodan_dns_failure_raises(shodan_key, monkeypatch):
    def _boom(host):
        raise OSError("no such host")

    monkeypatch.setattr(socket, "gethostbyname", _boom)
    with pytest.raises(RuntimeError, match="DNS resolve failed"):
        await shodan_service.lookup("nonexistent.invalid", client=_FakeClient({}))


@pytest.mark.asyncio
async def test_shodan_rejects_domain_resolving_to_blocked_ip(shodan_key, monkeypatch):
    # The hostname looks public, so only the resolved IP can catch loopback /
    # link-local. Nothing may be sent to Shodan or its InternetDB fallback.
    for blocked_ip in ("127.0.0.1", "169.254.169.254", "10.0.0.5"):
        monkeypatch.setattr(socket, "gethostbyname", lambda host, ip=blocked_ip: ip)
        client = _FakeClient({"ports": [], "data": []})
        with pytest.raises(HTTPException) as e:
            await shodan_service.lookup("internal.example.com", client=client)
        assert e.value.status_code == 400
        assert e.value.detail == "Private/localhost targets are blocked"
        assert client.calls == []


@pytest.mark.asyncio
async def test_shodan_allows_domain_resolving_to_public_ip(shodan_key, monkeypatch):
    monkeypatch.setattr(socket, "gethostbyname", lambda host: "93.184.216.34")
    client = _FakeClient({"ports": [443], "data": []})
    out = await shodan_service.lookup("example.com", client=client)
    assert out["ip"] == "93.184.216.34"
    assert client.calls[0]["url"].endswith("/shodan/host/93.184.216.34")


@pytest.mark.asyncio
async def test_shodan_dns_timeout_error_is_clean(shodan_key, monkeypatch):
    def _timeout(host):
        raise TimeoutError("timed out")

    monkeypatch.setattr(socket, "gethostbyname", _timeout)
    with pytest.raises(RuntimeError, match="DNS resolve failed"):
        await shodan_service.lookup("slow.example.com", client=_FakeClient({}))


@pytest.mark.asyncio
async def test_shodan_dns_resolution_is_bounded_by_timeout(shodan_key, monkeypatch):
    # A resolver that never answers must release the caller instead of pinning
    # the worker, so the lookup gives up on the same budget as the Shodan call.
    monkeypatch.setattr(settings, "scan_timeout_shodan", 0.05)

    def _hang(host):
        time.sleep(1.0)
        return "9.9.9.9"  # pragma: no cover — always outrun by the timeout

    monkeypatch.setattr(socket, "gethostbyname", _hang)
    started = time.monotonic()
    with pytest.raises(RuntimeError, match="DNS resolve failed"):
        await shodan_service.lookup("blackhole.example.com", client=_FakeClient({}))
    assert time.monotonic() - started < 0.5


def test_shodan_lookup_never_resolves_dns_on_the_event_loop():
    # AGENTS.md §3: the async path must not block; the resolver belongs in a
    # thread. Guard regression against a re-inlined socket.gethostbyname.
    import inspect

    src = inspect.getsource(shodan_service.lookup)
    assert "gethostbyname" not in src
    assert "socket" not in src
    assert "to_thread" in inspect.getsource(resolve_target_ip)


# --- POST /scan: the 400 must survive the orchestrator --------------------


@pytest.fixture
def scan_client(monkeypatch):
    """POST /scan with auth + DB stubbed; the rate-limit bucket is reset."""
    from fastapi.testclient import TestClient

    from app.core import rate_limit
    from app.core.security import require_user
    from app.db.session import get_session
    from app.main import create_app

    monkeypatch.setattr(settings, "rate_limit_per_hour", 100)
    rate_limit.reset_for_tests()
    app = create_app()
    app.dependency_overrides[require_user] = lambda: "user:test"
    app.dependency_overrides[get_session] = lambda: None
    with TestClient(app) as client:
        yield client
    rate_limit.reset_for_tests()


def test_scan_endpoint_400s_on_domain_resolving_to_blocked_ip(scan_client, monkeypatch):
    # The orchestrator swallows every source exception into errors[] and still
    # answers 200, so a blocked resolved IP has to be rejected before the
    # fan-out or the client never sees the 400.
    from app.routers import scan as scan_router

    async def _never_scan(*args, **kwargs):
        raise AssertionError("a blocked target must not reach the orchestrator")

    monkeypatch.setattr(socket, "gethostbyname", lambda host: "127.0.0.1")
    monkeypatch.setattr(scan_router.orchestrator, "run_scan", _never_scan)

    response = scan_client.post(
        "/api/v1/scan", json={"target": "internal.example.com", "force": True}
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "Private/localhost targets are blocked"


def test_scan_endpoint_allows_domain_resolving_to_public_ip(scan_client, monkeypatch):
    # Counter-test for the guard above: a public target must still scan.
    from app.routers import scan as scan_router

    seen: dict = {}

    async def _fake_scan(
        target, user_id, force=False, persist=None, *, resolved_ip=None
    ):
        # The pre-flight IP has to reach the orchestrator, otherwise Shodan
        # resolves the same name a second time.
        seen["resolved_ip"] = resolved_ip
        return {
            "scan_id": "11111111-1111-1111-1111-111111111111",
            "status": "completed",
        }

    monkeypatch.setattr(socket, "gethostbyname", lambda host: "93.184.216.34")
    monkeypatch.setattr(scan_router.orchestrator, "run_scan", _fake_scan)

    response = scan_client.post(
        "/api/v1/scan", json={"target": "example.com", "force": False}
    )

    assert response.status_code == 200
    assert response.json()["status"] == "completed"
    assert seen["resolved_ip"] == "93.184.216.34"


# --- crt.sh ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_crtsh_dedups_strips_and_lowercases():
    raw = [
        {
            "name_value": "*.Example.COM\nmail.example.com",
            "issuer_name": "Let's Encrypt",
            "not_before": "2024-01-01",
            "not_after": "2024-04-01",
        },
        {
            "name_value": "mail.example.com\nWWW.EXAMPLE.COM",
            "issuer_name": "Let's Encrypt",
            "not_before": "2024-01-01",
            "not_after": "2024-04-01",
        },
    ]
    out = await crtsh_service.lookup("example.com", client=_FakeClient(raw))
    subs = [s["subdomain"] for s in out["subdomains"]]
    assert out["domain"] == "example.com"
    assert out["count"] == 3
    assert subs == ["example.com", "mail.example.com", "www.example.com"]


@pytest.mark.asyncio
async def test_crtsh_caps_at_500():
    raw = [
        {
            "name_value": f"host{i}.example.com",
            "issuer_name": "CA",
            "not_before": "",
            "not_after": "",
        }
        for i in range(600)
    ]
    out = await crtsh_service.lookup("example.com", client=_FakeClient(raw))
    assert out["count"] == 500
    assert len(out["subdomains"]) == 500


@pytest.mark.asyncio
async def test_crtsh_empty_result():
    out = await crtsh_service.lookup("example.com", client=_FakeClient([]))
    assert out == {"domain": "example.com", "count": 0, "subdomains": []}


# --- WHOIS ----------------------------------------------------------------


def _install_fake_whois(monkeypatch, attrs: dict):
    """Stub the third-party `whois` module: whois.whois(target) -> obj with attrs."""
    mod = types.ModuleType("whois")

    class _W:
        pass

    w = _W()
    for k, v in attrs.items():
        setattr(w, k, v)

    mod.whois = lambda target: w
    monkeypatch.setitem(sys.modules, "whois", mod)
    return w


@pytest.mark.asyncio
async def test_whois_maps_fields_and_redacts_missing_emails(monkeypatch):
    _install_fake_whois(
        monkeypatch,
        {
            "registrar": "Example Registrar",
            "creation_date": "2020-01-01",
            "expiration_date": "2030-01-01",
            "name_servers": ["NS1.EXAMPLE.COM", "ns2.example.com"],
            "emails": None,  # GDPR redacted path
        },
    )
    out = await whois_service.lookup("example.com")
    assert out["registrar"] == "Example Registrar"
    assert out["name_servers"] == ["NS1.EXAMPLE.COM", "ns2.example.com"]
    assert out["emails"] == "redacted"


@pytest.mark.asyncio
async def test_whois_wraps_string_ns_and_keeps_emails(monkeypatch):
    _install_fake_whois(
        monkeypatch,
        {
            "registrar": "R",
            "creation_date": None,
            "expiration_date": None,
            "name_servers": "ns1.example.com",  # single string → [str]
            "emails": "admin@example.com",
        },
    )
    out = await whois_service.lookup("example.com")
    assert out["name_servers"] == ["ns1.example.com"]
    assert out["emails"] == "admin@example.com"
    assert out["creation_date"] is None


# --- Orchestrator terminal states ------------------------------------------


async def _no_cache_get(key: str):
    return None


async def _no_cache_set(*args, **kwargs):
    return None


@pytest.mark.asyncio
async def test_orchestrator_completed_when_all_ok(monkeypatch):
    async def ok(target, client=None):
        return {"ok": True}

    async def ok_whois(target):
        return {"registrar": "R"}

    monkeypatch.setattr(orchestrator.shodan_service, "lookup", ok)
    monkeypatch.setattr(orchestrator.crtsh_service, "lookup", ok)
    monkeypatch.setattr(orchestrator.whois_service, "lookup", ok_whois)
    monkeypatch.setattr(orchestrator.cache_mod, "cache_get_async", _no_cache_get)
    monkeypatch.setattr(orchestrator.cache_mod, "cache_set_async", _no_cache_set)

    payload = await orchestrator.run_scan("example.com", "u1", force=True)
    assert payload["status"] == "completed"
    assert payload["errors"] == []


@pytest.mark.asyncio
async def test_orchestrator_failed_when_all_sources_fail(monkeypatch):
    async def boom(target, client=None):
        raise RuntimeError("down")

    async def certspotter_down(target, client=None):
        raise RuntimeError("Cert Spotter is unavailable")

    async def boom_whois(target):
        raise RuntimeError("down")

    async def subfinder_down(target):
        raise RuntimeError("Subfinder CLI is unavailable on PATH")

    monkeypatch.setattr(orchestrator.shodan_service, "lookup", boom)
    monkeypatch.setattr(orchestrator.crtsh_service, "lookup", boom)
    monkeypatch.setattr(certspotter_service, "lookup", certspotter_down)
    monkeypatch.setattr(orchestrator.subfinder_service, "lookup", subfinder_down)
    monkeypatch.setattr(orchestrator.whois_service, "lookup", boom_whois)
    monkeypatch.setattr(orchestrator.cache_mod, "cache_get_async", _no_cache_get)
    monkeypatch.setattr(orchestrator.cache_mod, "cache_set_async", _no_cache_set)

    results, errors = await orchestrator.gather_results("example.com", force=True)
    assert results == {}
    assert {e["source"] for e in errors} == {
        "shodan",
        "crtsh",
        "whois",
    }

    payload = await orchestrator.run_scan("example.com", "u1", force=True)
    assert payload["status"] == "failed"


def test_to_thread_used_for_whois():
    # whois_service.lookup must offload blocking I/O (AGENTS.md §3); guard regression.
    import inspect

    src = inspect.getsource(whois_service.lookup)
    assert "to_thread" in src


def test_gather_never_raises_event_loop_safety():
    # gather_results uses return_exceptions=True → must not raise on source failure.
    import inspect

    src = inspect.getsource(orchestrator.gather_results)
    assert "return_exceptions=True" in src
    assert "asyncio" in sys.modules or asyncio is not None
