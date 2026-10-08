"""Perf evidence with mocked network (TODO Phase 4 item 4).

NOTE: these run with stubbed sources, so they prove orchestrator overhead
(cache + gather), not live-network latency. Live-network p95 (real Shodan
key + real crt.sh/WHOIS) must be re-measured manually and logged here:
live p95 cache-miss: NOT MEASURED YET (needs SHODAN_API_KEY).
"""

from __future__ import annotations

import asyncio
import time

import pytest

from app.core import cache as cache_mod
from app.core.config import settings
from app.services import orchestrator


@pytest.mark.asyncio
async def test_cache_hit_under_1_5s(monkeypatch, tmp_path):
    """Pre-populated SQLite cache → gather_results serves all 3 sources fast."""
    monkeypatch.setattr(settings, "cache_backend", "sqlite")
    monkeypatch.setattr(settings, "sqlite_path", str(tmp_path / "perf.db"))
    target = "perf-hit.example.com"
    for source in ("shodan", "crtsh", "whois"):
        cache_mod.cache_set(settings.sqlite_path, f"{source}:{target}", {"src": source})

    async def _must_not_call(*args, **kwargs):  # proves no network on cache hit
        raise AssertionError("source lookup called despite warm cache")

    monkeypatch.setattr(orchestrator.shodan_service, "lookup", _must_not_call)
    monkeypatch.setattr(orchestrator.crtsh_service, "lookup", _must_not_call)
    monkeypatch.setattr(orchestrator.whois_service, "lookup", _must_not_call)

    start = time.perf_counter()
    results, errors = await orchestrator.gather_results(target, force=False)
    elapsed = time.perf_counter() - start
    print(f"\ncache-hit gather_results: {elapsed:.3f}s")
    # `host` is host_enrichment_service.enrich() applied to the cached Shodan
    # payload: a pure synchronous derivation with no I/O, which is why it is
    # allowed on a cache hit when the network-bound `history` block is not.
    assert set(results) == {"shodan", "crtsh", "whois", "host"}
    assert errors == []
    assert elapsed < 1.5


@pytest.mark.asyncio
async def test_cache_miss_mocked_under_12s(monkeypatch):
    """3 stubbed sources sleeping 0.3s concurrently → fast, status completed."""
    monkeypatch.setattr(settings, "cache_backend", "sqlite")

    async def _slow_ok_shodan(target, client=None):
        await asyncio.sleep(0.3)
        return {"ports": [80], "vulns": []}

    async def _slow_ok_crtsh(target, client=None):
        await asyncio.sleep(0.3)
        return {"domain": target, "count": 0, "subdomains": []}

    async def _slow_ok_whois(target):
        await asyncio.sleep(0.3)
        return {"registrar": "R"}

    async def _no_set(*args, **kwargs):
        return None

    monkeypatch.setattr(orchestrator.shodan_service, "lookup", _slow_ok_shodan)
    monkeypatch.setattr(orchestrator.crtsh_service, "lookup", _slow_ok_crtsh)
    monkeypatch.setattr(orchestrator.whois_service, "lookup", _slow_ok_whois)
    monkeypatch.setattr(orchestrator.cache_mod, "cache_set_async", _no_set)

    start = time.perf_counter()
    payload = await orchestrator.run_scan("perf-miss.example.com", "u1", force=True)
    elapsed = time.perf_counter() - start
    print(f"\ncache-miss run_scan (3x0.3s mocked): {elapsed:.3f}s")
    assert payload["status"] == "completed"
    assert elapsed < 12
