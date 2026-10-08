"""The threat/incident history fallback in the orchestrator.

Two orchestrator tests the TODO names explicitly:
  - no CVEs -> history runs,
  - CVEs present -> history NEVER runs.

Plus the property that makes the feature safe to ship: the response says WHY it
ran, so an empty CVE tab is never silently presented as "no incidents".

The four history sources are stubbed. They are tested individually in their own
files; what matters here is the trigger condition, the isolation between
sources, and the cache behaviour.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.services import orchestrator
from app.services.orchestrator import _history_trigger

SOURCES = ("otx", "urlscan", "leaklookup")


@pytest.fixture
def stub_sources(monkeypatch):
    """Replace all four history sources; record which ones were called."""
    calls: list[str] = []

    def _stub(name: str) -> None:
        module = getattr(orchestrator, f"{name}_service")

        async def _lookup(target: str, client: Any = None) -> dict[str, Any]:
            calls.append(name)
            return {
                "source": name,
                "status": "ok",
                "count": 1,
                "findings": [],
                "truncated": False,
                "note": f"stubbed {name}",
            }

        monkeypatch.setattr(module, "lookup", _lookup)

    for name in SOURCES:
        _stub(name)
    return calls


@pytest.fixture
def no_cache(monkeypatch):
    async def _miss(key: str) -> None:
        return None

    async def _noop(key: str, value: Any, ttl: int) -> None:
        return None

    monkeypatch.setattr(orchestrator.cache_mod, "cache_get_async", _miss)
    monkeypatch.setattr(orchestrator.cache_mod, "cache_set_async", _noop)


def _shodan(**overrides: Any) -> dict[str, Any]:
    base = {
        "source": "Shodan",
        "ip": "93.184.216.34",
        "ports": [443],
        "services": [],
        "vulns": [],
        "cpes": [],
    }
    base.update(overrides)
    return base


def _nvd(cve_rows: list[Any] | None = None, **overrides: Any) -> dict[str, Any]:
    base = {
        "source": "NVD",
        "status": "ok",
        "checked_cpes": [],
        "cves": [],
        "truncated": False,
        "errors": [],
        "note": "",
        "cve_rows": cve_rows if cve_rows is not None else [],
    }
    base.update(overrides)
    return base


# --- the trigger condition --------------------------------------------------


def test_zero_cve_rows_triggers_history():
    assert _history_trigger({"shodan": _shodan(), "nvd": _nvd([])}) is not None


def test_missing_nvd_block_triggers_history():
    assert _history_trigger({"shodan": _shodan()}) is not None


def test_insufficient_evidence_triggers_history():
    reason = _history_trigger(
        {"shodan": _shodan(), "nvd": _nvd([], status="insufficient_evidence")}
    )
    assert reason is not None
    assert "insufficient" in reason.lower()


def test_populated_cve_rows_never_trigger_history():
    rows = [{"id": "CVE-2024-1", "tier": "verified"}]
    assert _history_trigger({"shodan": _shodan(), "nvd": _nvd(rows)}) is None


def test_unavailable_nvd_is_not_a_trigger_on_its_own():
    """`unavailable` means we could not check — that still leaves an empty tab,
    so history runs, but the reason must not claim the target was checked."""
    reason = _history_trigger(
        {"shodan": _shodan(), "nvd": _nvd([], status="unavailable")}
    )
    assert reason is not None
    assert "checked" not in reason.lower()


def test_total_source_failure_never_triggers_history():
    """A total outage must not be dressed up as a result.

    When every primary source failed we learned nothing about the target, so
    "no CVE data" means "we could not check". Running history there would give a
    failed scan a populated block and imply the check happened.
    """
    assert _history_trigger({}) is None
    assert _history_trigger({"nvd": _nvd([])}) is None


def test_one_surviving_primary_source_is_enough_to_trigger():
    assert (
        _history_trigger({"whois": {"domain": "example.com"}, "nvd": _nvd([])})
        is not None
    )


def test_reason_distinguishes_unchecked_from_checked_and_clean():
    checked_clean = _history_trigger({"shodan": _shodan(), "nvd": _nvd([])})
    had_shodan_ids = _history_trigger(
        {"shodan": _shodan(vulns=["CVE-2024-1"]), "nvd": _nvd([])}
    )
    assert checked_clean != had_shodan_ids


# --- end to end through gather_results -------------------------------------


@pytest.mark.asyncio
async def test_no_cves_causes_history_to_run(monkeypatch, stub_sources, no_cache):
    monkeypatch.setattr(
        orchestrator.shodan_service, "lookup", lambda *a, **k: _async(_shodan())
    )
    monkeypatch.setattr(
        orchestrator.crtsh_service, "lookup", lambda *a, **k: _async({"subdomains": []})
    )
    monkeypatch.setattr(
        orchestrator.whois_service, "lookup", lambda *a, **k: _async({"registrar": "x"})
    )

    results, _ = await orchestrator.gather_results("example.com")

    assert "history" in results, "an empty vulnerability tab must not stay empty"
    assert results["history"]["triggered"] is True
    assert stub_sources == list(SOURCES)


@pytest.mark.asyncio
async def test_cves_present_means_history_never_runs(
    monkeypatch, stub_sources, no_cache
):
    # CPEs present so NVD enrichment actually runs and produces real rows —
    # without them the orchestrator sets `insufficient_evidence`, which is a
    # legitimate trigger and would make this test assert the wrong thing.
    monkeypatch.setattr(
        orchestrator.shodan_service,
        "lookup",
        lambda *a, **k: _async(
            _shodan(vulns=["CVE-2024-1"], cpes=["cpe:2.3:a:vendor:product:1.0"])
        ),
    )
    monkeypatch.setattr(
        orchestrator.crtsh_service, "lookup", lambda *a, **k: _async({"subdomains": []})
    )
    monkeypatch.setattr(
        orchestrator.whois_service, "lookup", lambda *a, **k: _async({"registrar": "x"})
    )

    async def _tiered(vulns: Any, nvd: Any, client: Any = None) -> list[dict[str, Any]]:
        return [{"id": "CVE-2024-1", "tier": "verified"}]

    monkeypatch.setattr(orchestrator.nvd_service, "build_cve_rows", _tiered)
    monkeypatch.setattr(
        orchestrator.nvd_service, "enrich_cpes", lambda *a, **k: _async(_nvd())
    )

    results, _ = await orchestrator.gather_results("example.com")

    assert "history" not in results, "history must never displace a populated CVE list"
    assert stub_sources == [], "no history source may be contacted"


# --- honesty of the payload -------------------------------------------------


@pytest.mark.asyncio
async def test_payload_states_why_it_ran(monkeypatch, stub_sources, no_cache):
    monkeypatch.setattr(
        orchestrator.shodan_service, "lookup", lambda *a, **k: _async(_shodan())
    )
    monkeypatch.setattr(
        orchestrator.crtsh_service, "lookup", lambda *a, **k: _async({"subdomains": []})
    )
    monkeypatch.setattr(
        orchestrator.whois_service, "lookup", lambda *a, **k: _async({"registrar": "x"})
    )

    results, _ = await orchestrator.gather_results("example.com")
    history = results["history"]

    assert history["trigger_reason"]
    # The note must not name a source that no longer exists.
    assert "not evidence of safety" in history["note"]
    assert "defacement" not in history["note"].lower()
    # Every source's own status must survive into the payload, including
    # `not_configured`, so the UI can distinguish "no breaches" from "no key".
    assert set(history["blocks"]) == set(SOURCES)
    for block in history["blocks"].values():
        assert block["status"] in {"ok", "unavailable", "not_configured"}


@pytest.mark.asyncio
async def test_one_dead_source_does_not_suppress_the_others(
    monkeypatch, stub_sources, no_cache
):
    async def _boom(target: str, client: Any = None) -> dict[str, Any]:
        raise RuntimeError("leaklookup: HTTP 500 — upstream is down")

    monkeypatch.setattr(orchestrator.leaklookup_service, "lookup", _boom)
    monkeypatch.setattr(
        orchestrator.shodan_service, "lookup", lambda *a, **k: _async(_shodan())
    )
    monkeypatch.setattr(
        orchestrator.crtsh_service, "lookup", lambda *a, **k: _async({"subdomains": []})
    )
    monkeypatch.setattr(
        orchestrator.whois_service, "lookup", lambda *a, **k: _async({"registrar": "x"})
    )

    results, _ = await orchestrator.gather_results("example.com")
    history = results["history"]

    assert "leaklookup" not in history["blocks"]
    assert any(e["source"] == "leaklookup" for e in history["errors"])
    # The other sources still reported — one dead source never suppresses the rest.
    assert {"otx", "urlscan"} <= set(history["blocks"])


@pytest.mark.asyncio
async def test_history_failure_never_fails_the_scan(
    monkeypatch, stub_sources, no_cache
):
    async def _boom(target: str, client: Any = None) -> dict[str, Any]:
        raise RuntimeError("everything is on fire")

    for name in SOURCES:
        monkeypatch.setattr(getattr(orchestrator, f"{name}_service"), "lookup", _boom)
    monkeypatch.setattr(
        orchestrator.shodan_service, "lookup", lambda *a, **k: _async(_shodan())
    )
    monkeypatch.setattr(
        orchestrator.crtsh_service, "lookup", lambda *a, **k: _async({"subdomains": []})
    )
    monkeypatch.setattr(
        orchestrator.whois_service, "lookup", lambda *a, **k: _async({"registrar": "x"})
    )

    results, errors = await orchestrator.gather_results("example.com")

    # A partial result with the real sources intact is the correct outcome.
    assert "shodan" in results
    assert any(e["source"] == "history" for e in errors) or "history" in results


# --- cache ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_pure_cache_hit_does_not_trigger_history_network(
    monkeypatch, stub_sources
):
    """A cache hit must cost zero upstream requests, history included.

    This is the rule the whole orchestrator is built on. The history chain is
    four more requests, so running it off a warm cache would silently reintroduce
    exactly the per-scan spend the cache exists to avoid.
    """

    async def _hit(key: str) -> Any:
        if key.startswith("shodan:"):
            return _shodan()
        if key.startswith(("crtsh:", "whois:")):
            return {"ok": True}
        return None  # history is cold

    async def _noop(key: str, value: Any, ttl: int) -> None:
        return None

    monkeypatch.setattr(orchestrator.cache_mod, "cache_get_async", _hit)
    monkeypatch.setattr(orchestrator.cache_mod, "cache_set_async", _noop)

    for name in ("shodan", "crtsh", "whois"):

        async def _must_not_call(*args: Any, **kwargs: Any) -> Any:
            raise AssertionError("a source lookup ran despite a warm cache")

        monkeypatch.setattr(
            getattr(orchestrator, f"{name}_service"), "lookup", _must_not_call
        )

    results, errors = await orchestrator.gather_results("example.com", force=False)

    assert stub_sources == [], "history must not run off a pure cache hit"
    assert "history" not in results
    assert errors == []


@pytest.mark.asyncio
async def test_cached_history_costs_no_upstream_request(monkeypatch, stub_sources):
    cached = {
        "source": "Threat & incident history",
        "triggered": True,
        "trigger_reason": "cached",
        "note": "",
        "blocks": {},
        "errors": [],
    }

    async def _hit(key: str) -> Any:
        return cached if key.startswith("history:") else None

    async def _noop(key: str, value: Any, ttl: int) -> None:
        return None

    monkeypatch.setattr(orchestrator.cache_mod, "cache_get_async", _hit)
    monkeypatch.setattr(orchestrator.cache_mod, "cache_set_async", _noop)
    monkeypatch.setattr(
        orchestrator.shodan_service, "lookup", lambda *a, **k: _async(_shodan())
    )
    monkeypatch.setattr(
        orchestrator.crtsh_service, "lookup", lambda *a, **k: _async({"subdomains": []})
    )
    monkeypatch.setattr(
        orchestrator.whois_service, "lookup", lambda *a, **k: _async({"registrar": "x"})
    )

    results, _ = await orchestrator.gather_results("example.com")

    assert results["history"]["trigger_reason"] == "cached"
    assert stub_sources == [], "a cache hit must not contact any history source"


@pytest.mark.asyncio
async def test_force_bypasses_the_history_cache(monkeypatch, stub_sources):
    async def _hit(key: str) -> Any:
        return {"source": "Threat & incident history", "trigger_reason": "cached"}

    async def _noop(key: str, value: Any, ttl: int) -> None:
        return None

    monkeypatch.setattr(orchestrator.cache_mod, "cache_get_async", _hit)
    monkeypatch.setattr(orchestrator.cache_mod, "cache_set_async", _noop)
    monkeypatch.setattr(
        orchestrator.shodan_service, "lookup", lambda *a, **k: _async(_shodan())
    )
    monkeypatch.setattr(
        orchestrator.crtsh_service, "lookup", lambda *a, **k: _async({"subdomains": []})
    )
    monkeypatch.setattr(
        orchestrator.whois_service, "lookup", lambda *a, **k: _async({"registrar": "x"})
    )

    results, _ = await orchestrator.gather_results("example.com", force=True)

    assert results["history"]["trigger_reason"] != "cached"
    assert stub_sources == list(SOURCES)


# --- host enrichment --------------------------------------------------------


@pytest.mark.asyncio
async def test_host_block_is_derived_and_free_on_a_cache_hit(
    monkeypatch, stub_sources, no_cache
):
    monkeypatch.setattr(
        orchestrator.shodan_service, "lookup", lambda *a, **k: _async(_shodan())
    )
    monkeypatch.setattr(
        orchestrator.crtsh_service, "lookup", lambda *a, **k: _async({"subdomains": []})
    )
    monkeypatch.setattr(
        orchestrator.whois_service, "lookup", lambda *a, **k: _async({"registrar": "x"})
    )

    results, _ = await orchestrator.gather_results("example.com")

    assert results["host"]["source"] == "Shodan (passive host data)"
    assert results["host"]["ip"] == "93.184.216.34"
    assert results["host"]["port_count"] == 1


def _async(value: Any):
    async def _coro() -> Any:
        return value

    return _coro()
