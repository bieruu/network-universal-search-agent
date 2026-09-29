import pytest

from app.services import orchestrator


async def _no_cache_get(key: str):
    return None


async def _no_cache_set(*args, **kwargs):
    return None


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
    monkeypatch.setattr(orchestrator.whois_service, "lookup", ok_whois)
    monkeypatch.setattr(orchestrator.cache_mod, "cache_get_async", _no_cache_get)
    monkeypatch.setattr(orchestrator.cache_mod, "cache_set_async", _no_cache_set)

    results, errors = await orchestrator.gather_results("example.com", force=True)
    assert "shodan" in results and "whois" in results
    assert any(e["source"] == "crtsh" for e in errors)

    payload = await orchestrator.run_scan("example.com", "u1", force=True)
    assert payload["status"] == "partial"
    assert payload["risk_score"] is not None
