"""Failure-mode tests: timeouts, expired keys, redacted WHOIS, total outage.

Real external network is never touched: every source lookup is faked and
cache writes are stubbed. Covers TODO Phase 4 item 3 (UX-failure paths):
each scenario must land in errors[] with a partial/failed status, never raise.
"""

from __future__ import annotations

import asyncio
import sys
import types

import httpx
import pytest

from app.core.config import settings
from app.services import orchestrator, whois_service


async def _no_cache_get(key: str):
    return None


async def _no_cache_set(*args, **kwargs):
    return None


def _stub_cache(monkeypatch):
    monkeypatch.setattr(orchestrator.cache_mod, "cache_get_async", _no_cache_get)
    monkeypatch.setattr(orchestrator.cache_mod, "cache_set_async", _no_cache_set)


async def _ok_shodan(target, client=None):
    return {"ip": "93.184.216.34", "ports": [80, 443], "services": [], "vulns": []}


async def _ok_crtsh(target, client=None):
    return {"domain": target, "count": 1, "subdomains": []}


async def _ok_whois(target):
    return {"domain": target, "registrar": "Example Registrar", "emails": "redacted"}


@pytest.mark.asyncio
async def test_crtsh_timeout_becomes_partial_not_500(monkeypatch):
    """crt.sh sleep (5s) exceeds orchestrator timeout (1s) → errors[] + partial."""
    monkeypatch.setattr(settings, "scan_timeout_crtsh", 1)
    _stub_cache(monkeypatch)

    async def slow_crtsh(target, client=None):
        await asyncio.sleep(5)
        return {"domain": target, "count": 0, "subdomains": []}  # pragma: no cover

    monkeypatch.setattr(orchestrator.shodan_service, "lookup", _ok_shodan)
    monkeypatch.setattr(orchestrator.crtsh_service, "lookup", slow_crtsh)
    monkeypatch.setattr(orchestrator.whois_service, "lookup", _ok_whois)

    payload = await orchestrator.run_scan(
        "example.com", "u1", force=True
    )  # must not raise
    assert payload["status"] == "partial"
    assert "shodan" in payload["results"] and "whois" in payload["results"]
    assert "crtsh" not in payload["results"]
    crtsh_errors = [e for e in payload["errors"] if e["source"] == "crtsh"]
    assert len(crtsh_errors) == 1


@pytest.mark.asyncio
async def test_shodan_401_expired_key_becomes_partial(monkeypatch):
    """Expired/invalid Shodan key (HTTP 401) → errors[] entry, other cards render."""
    _stub_cache(monkeypatch)
    req = httpx.Request("GET", "https://api.shodan.io/shodan/host/93.184.216.34")
    resp = httpx.Response(401, request=req)

    async def shodan_401(target, client=None):
        raise httpx.HTTPStatusError("401 Unauthorized", request=req, response=resp)

    monkeypatch.setattr(orchestrator.shodan_service, "lookup", shodan_401)
    monkeypatch.setattr(orchestrator.crtsh_service, "lookup", _ok_crtsh)
    monkeypatch.setattr(orchestrator.whois_service, "lookup", _ok_whois)

    results, errors = await orchestrator.gather_results("example.com", force=True)
    assert "shodan" not in results
    assert any(e["source"] == "shodan" and "401" in e["message"] for e in errors)

    payload = await orchestrator.run_scan("example.com", "u1", force=True)
    assert payload["status"] == "partial"


@pytest.mark.asyncio
async def test_whois_redacted_emails_still_completes(monkeypatch):
    """GDPR-redacted WHOIS (emails=None) → 'redacted', scan still completes."""
    mod = types.ModuleType("whois")

    class _W:
        pass

    w = _W()
    w.registrar = "Example Registrar"
    w.creation_date = "2020-01-01"
    w.expiration_date = "2030-01-01"
    w.name_servers = ["ns1.example.com"]
    w.emails = None  # redacted by privacy law
    mod.whois = lambda target: w
    monkeypatch.setitem(sys.modules, "whois", mod)

    out = await whois_service.lookup("example.com")
    assert out["emails"] == "redacted"

    _stub_cache(monkeypatch)
    monkeypatch.setattr(orchestrator.shodan_service, "lookup", _ok_shodan)
    monkeypatch.setattr(orchestrator.crtsh_service, "lookup", _ok_crtsh)
    # whois_service.lookup left real: exercises the redacted path end-to-end.
    payload = await orchestrator.run_scan("example.com", "u1", force=True)
    assert payload["status"] == "completed"
    assert payload["results"]["whois"]["emails"] == "redacted"
    assert payload["errors"] == []


@pytest.mark.asyncio
async def test_full_failure_all_sources_down_never_raises(monkeypatch):
    """All 3 sources raise different error types → status failed, 3 errors, no raise."""
    _stub_cache(monkeypatch)

    async def shodan_down(target, client=None):
        raise RuntimeError("shodan: connection refused")

    async def crtsh_slow(target, client=None):
        raise asyncio.TimeoutError("crt.sh timed out")

    async def whois_down(target):
        raise httpx.ConnectError("DNS unreachable")

    monkeypatch.setattr(orchestrator.shodan_service, "lookup", shodan_down)
    monkeypatch.setattr(orchestrator.crtsh_service, "lookup", crtsh_slow)
    monkeypatch.setattr(orchestrator.whois_service, "lookup", whois_down)

    results, errors = await orchestrator.gather_results("example.com", force=True)
    assert results == {}
    assert {e["source"] for e in errors} == {"shodan", "crtsh", "whois"}

    payload = await orchestrator.run_scan(
        "example.com", "u1", force=True
    )  # must not raise
    assert payload["status"] == "failed"
    assert len(payload["errors"]) == 3
