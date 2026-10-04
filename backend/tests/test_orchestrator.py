import pytest

from app.services import orchestrator


async def _no_cache_get(key: str):
    return None


async def _no_cache_set(*args, **kwargs):
    return None


async def _missing_subfinder(target):
    raise RuntimeError("Subfinder CLI is unavailable on PATH")


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
    monkeypatch.setattr(orchestrator.cache_mod, "cache_get_async", _no_cache_get)
    monkeypatch.setattr(orchestrator.cache_mod, "cache_set_async", _no_cache_set)

    results, errors = await orchestrator.gather_results("example.com", force=True)

    assert results["crtsh"]["subdomains"][0]["subdomain"] == "www.example.com"
    assert any(
        error["source"] == "crtsh" and "503" in error["message"] for error in errors
    )
    assert not any(error["source"] == "subfinder" for error in errors)


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
    monkeypatch.setattr(orchestrator.subfinder_service, "lookup", fail_subfinder)
    monkeypatch.setattr(orchestrator.cache_mod, "cache_get_async", _no_cache_get)
    monkeypatch.setattr(orchestrator.cache_mod, "cache_set_async", _no_cache_set)

    results, errors = await orchestrator.gather_results("example.com", force=True)

    assert "crtsh" not in results
    assert {error["source"] for error in errors} == {"crtsh", "subfinder"}
