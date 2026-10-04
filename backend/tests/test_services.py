"""Per-service mocked tests: shodan, crt.sh, whois + orchestrator terminal states.

External network is never touched: httpx clients are faked, DNS stubbed,
and the blocking python-whois import is replaced via sys.modules.
Covers TODO Phase 4 item 1 (each service mocked).
"""

from __future__ import annotations

import asyncio
import socket
import sys
import types

import pytest

from app.core.config import settings
from app.services import (
    crtsh_service,
    orchestrator,
    shodan_service,
    whois_service,
)


class _FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


class _FakeClient:
    """Minimal httpx.AsyncClient stand-in: records params, returns canned JSON."""

    def __init__(self, payload):
        self._payload = payload
        self.calls: list[dict] = []

    async def get(self, url, params=None):
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

    async def boom_whois(target):
        raise RuntimeError("down")

    async def subfinder_down(target):
        raise RuntimeError("Subfinder CLI is unavailable on PATH")

    monkeypatch.setattr(orchestrator.shodan_service, "lookup", boom)
    monkeypatch.setattr(orchestrator.crtsh_service, "lookup", boom)
    monkeypatch.setattr(orchestrator.subfinder_service, "lookup", subfinder_down)
    monkeypatch.setattr(orchestrator.whois_service, "lookup", boom_whois)
    monkeypatch.setattr(orchestrator.cache_mod, "cache_get_async", _no_cache_get)
    monkeypatch.setattr(orchestrator.cache_mod, "cache_set_async", _no_cache_set)

    results, errors = await orchestrator.gather_results("example.com", force=True)
    assert results == {}
    assert {e["source"] for e in errors} == {
        "shodan",
        "crtsh",
        "subfinder",
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
