"""The keyword fallback must never become host evidence.

`search_keywords` is wired into `gather_results` so a target with no CPE
evidence still gets *something* in the vulnerability card. The risk that
introduces is precise and worth pinning: NVD `keywordSearch` matches CVE
**descriptions**, so a hit means "a CVE whose text mentions nginx exists", not
"this host runs a vulnerable nginx". If those rows ever reached the score, a
target could read 100 on the strength of an unrelated CVE.

These tests cover the integration (orchestrator wiring + risk scoring), which the
service-level tests cannot: they are what prove the fallback is inert where it
matters.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.services import orchestrator, risk


@pytest.fixture
def stub_sources(monkeypatch):
    """Primary sources only; NVD itself is real so the fallback path executes."""

    async def _shodan(target: str, client: Any = None, resolved_ip: Any = None) -> Any:
        return {
            "source": "Shodan",
            "ip": "93.184.216.34",
            "ports": [80, 443],
            # No CPEs at all: this is the situation that triggers the fallback.
            "cpes": [],
            # A dict, not a bare string: this is the real Shodan shape, and the
            # regression this file guards is a caller that forgot to pull "product" out.
            "services": [
                {"port": 443, "transport": "tcp", "product": "nginx", "version": "1.25"}
            ],
            "vulns": [],
        }

    async def _crtsh(target: str, client: Any = None) -> Any:
        return {"domain": target, "count": 0, "subdomains": []}

    async def _whois(target: str) -> Any:
        return {"domain": target, "registrar": "Example"}

    async def _no_set(*args: Any, **kwargs: Any) -> None:
        return None

    async def _miss(key: str) -> None:
        return None

    monkeypatch.setattr(orchestrator.shodan_service, "lookup", _shodan)
    monkeypatch.setattr(orchestrator.crtsh_service, "lookup", _crtsh)
    monkeypatch.setattr(orchestrator.whois_service, "lookup", _whois)
    monkeypatch.setattr(orchestrator.cache_mod, "cache_get_async", _miss)
    monkeypatch.setattr(orchestrator.cache_mod, "cache_set_async", _no_set)
    for name in ("otx", "urlscan", "leaklookup"):

        def _stub(*args: Any, _name: str = name, **kwargs: Any) -> Any:
            return _async(
                {
                    "source": _name,
                    "status": "ok",
                    "count": 0,
                    "findings": [],
                    "truncated": False,
                    "note": "",
                }
            )

        monkeypatch.setattr(getattr(orchestrator, f"{name}_service"), "lookup", _stub)


def _async(value: Any):
    async def _coro() -> Any:
        return value

    return _coro()


def _shodan_payload(**overrides: Any) -> dict[str, Any]:
    base = {
        "source": "Shodan",
        "ip": "93.184.216.34",
        "ports": [80, 443],
        "services": [],
        "vulns": [],
        "cpes": [],
    }
    base.update(overrides)
    return base


# --- scoring ----------------------------------------------------------------


def test_keyword_rows_are_never_scored():
    """A CRITICAL keyword lead must contribute nothing to the score.

    Without this, any target whose banner mentions a word shared with a
    critical CVE reaches vuln_factor 1.0 — 25 of the 100 points, on no evidence.
    """
    rows = [
        {
            "id": "CVE-2024-0001",
            "tier": "unverified",
            "keyword_derived": True,
            "source": "NVD (keyword)",
            "severity": "CRITICAL",
            "cvss": 10.0,
        }
    ]
    _score, breakdown = risk.score(
        {"shodan": _shodan_payload(), "nvd": _rows_payload(rows)}
    )

    assert breakdown["vulns"] == 0.0
    # Surfaced as a count so the UI can say "N leads, none scored".
    assert breakdown["keyword_leads"] == 1.0


def test_keyword_status_marks_coverage_uncertain():
    """With leads on screen, the vuln component must not read as "checked, fine"."""
    _score, breakdown = risk.score(
        {
            "shodan": _shodan_payload(),
            "nvd": _rows_payload(
                [
                    {
                        "id": "CVE-2024-0010",
                        "tier": "unverified",
                        "keyword_derived": True,
                        "severity": "MEDIUM",
                        "cvss": 5.0,
                    }
                ]
            ),
        }
    )
    assert breakdown.get("vulns_incomplete") == 1.0


def test_real_evidence_still_scores():
    """The guard must not have broken the normal exact-CPE path."""
    _score, breakdown = risk.score(
        {"shodan": _shodan_payload(), "nvd": _found_payload(_verified_row())}
    )

    assert breakdown["vulns"] > 0.0
    assert "keyword_leads" not in breakdown
    assert "vulns_incomplete" not in breakdown


def test_mixed_rows_score_only_the_real_evidence():
    _score, breakdown = risk.score(
        {
            "shodan": _shodan_payload(),
            "nvd": _found_payload(
                _verified_row(severity="LOW", cvss=2.0, cve_id="CVE-2024-0003"),
                # A CRITICAL lead sitting in the same block must not escalate it.
                {
                    "id": "CVE-2024-0004",
                    "tier": "unverified",
                    "keyword_derived": True,
                    "severity": "CRITICAL",
                    "cvss": 10.0,
                },
            ),
        }
    )

    assert breakdown["vulns"] > 0.0
    assert breakdown["vulns"] < 1.0
    assert breakdown["keyword_leads"] == 1.0


def _verified_row(
    cve_id: str = "CVE-2024-0002",
    severity: str = "HIGH",
    cvss: float = 8.0,
) -> dict[str, Any]:
    return {
        "id": cve_id,
        "tier": "verified",
        "source": "NVD",
        "severity": severity,
        "cvss": cvss,
        "evidence_cpe": "cpe:2.3:a:nginx:nginx:1.25:*:*:*:*:*:*:*",
    }


def _found_payload(*rows: dict[str, Any]) -> dict[str, Any]:
    """An exact-CPE `found` block — the status the keyword path must never fake."""
    return {
        "source": "NVD",
        "status": "found",
        "method": "cpe_match",
        "checked_cpes": ["cpe:2.3:a:nginx:nginx:1.25:*:*:*:*:*:*:*"],
        "keywords": [],
        "cves": list(rows),
        "cve_rows": list(rows),
        "truncated": False,
        "errors": [],
        "note": "",
    }


def _rows_payload(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """A keyword-search block as the orchestrator actually stores it.

    `cve_rows` is included because `build_cve_rows` writes it after the search,
    and `risk.score` prefers that tiered path over the raw `cves` list.
    """
    return {
        "source": "NVD",
        "status": "keyword_derived",
        "method": "keyword_search",
        "keywords": ["nginx"],
        "checked_cpes": [],
        "cves": list(rows),
        "cve_rows": [
            {**row, "keyword_derived": True, "evidence_cpe": None} for row in rows
        ],
        "truncated": False,
        "errors": [],
        "note": "Keyword-derived: leads, not confirmation this host is affected.",
    }


# --- orchestrator wiring ----------------------------------------------------


@pytest.mark.asyncio
async def test_keyword_fallback_runs_when_there_are_no_cpes(monkeypatch, stub_sources):
    calls: list[Any] = []

    async def _search(
        keywords: Any, client: Any = None, per_keyword: Any = None
    ) -> Any:
        calls.append(keywords)
        return _rows_payload(
            [{"id": "CVE-2024-0005", "tier": "unverified", "keyword_derived": True}]
        )

    monkeypatch.setattr(orchestrator.nvd_service, "search_keywords", _search)

    results, _ = await orchestrator.gather_results("example.com", force=True)

    # The regression this pins: `derive_keywords` only iterates top-level
    # STRINGS, so handing it the service dicts returned [] and the fallback
    # silently never ran — the card stayed at 0 with every test still green.
    assert calls == [["nginx"]], f"terms not derived from the product: {calls}"
    assert results["nvd"]["status"] == "keyword_derived"


def test_keyword_inputs_prefers_product_then_cpe_then_hostname():
    payload = {
        "services": [
            {"port": 80, "product": "nginx"},
            {"port": 443, "product": "  "},  # blank is dropped
            {"port": 22},  # no product key at all
            "not-a-dict",  # malformed entry
        ],
        "hostnames": ["a.example.com", 42, "b.example.com"],
    }
    nvd = {"checked_cpes": ["cpe:2.3:a:cloudflare:cloudflare:*:*:*:*:*:*:*"]}
    assert orchestrator._keyword_inputs(payload, nvd) == [
        "nginx",
        "cloudflare",
        "a.example.com",
        "b.example.com",
    ]


def test_keyword_inputs_fall_back_to_the_cpe_when_no_product_string():
    """The case that left the card at 0.

    Shodan returns a CPE for a target whose service banners carry an EMPTY
    product string. Keying the fallback only on `product` finds nothing there,
    so the CPE vendor/product — which we already queried NVD with — is the term
    that actually rescues it.
    """
    payload = {
        "services": [{"port": 443, "product": ""}, {"port": 80}],
        "hostnames": [],
    }
    nvd = {"checked_cpes": ["cpe:2.3:a:cloudflare:cloudflare:*:*:*:*:*:*:*"]}
    # vendor == product here, and the dedupe is what makes this one term.
    assert orchestrator._keyword_inputs(payload, nvd) == ["cloudflare"]


def test_keyword_inputs_dedupe_and_tolerate_a_malformed_cpe():
    payload = {"services": [], "hostnames": []}
    nvd = {
        "checked_cpes": [
            "cpe:2.3:a:nginx:nginx:1.25:*:*:*:*:*:*:*",
            "cpe:2.3:a:nginx:nginx:*:*:*:*:*:*:*:*",  # same vendor/product again
            "cpe:/a:apache:httpd:2.4",  # CPE 2.2 URI, not parsed here
            "garbage",
            None,
        ]
    }
    assert orchestrator._keyword_inputs(payload, nvd) == ["nginx"]


def test_keyword_inputs_survive_a_missing_nvd_block():
    assert orchestrator._keyword_inputs({"services": [], "hostnames": []}, None) == []


@pytest.mark.asyncio
async def test_keyword_fallback_does_not_run_when_cpes_matched(
    monkeypatch, stub_sources
):
    """Replacing a real exact-CPE result with keyword leads would downgrade it."""
    monkeypatch.setattr(
        orchestrator.shodan_service, "lookup", lambda *a, **k: _async(_shodan_payload())
    )
    monkeypatch.setattr(
        orchestrator.shodan_service,
        "lookup",
        lambda *a, **k: _async(
            _shodan_payload(cpes=["cpe:2.3:a:nginx:nginx:1.25:*:*:*:*:*:*:*"])
        ),
    )

    async def _enrich(cpes: Any, client: Any = None, **kwargs: Any) -> Any:
        return {
            "source": "NVD",
            "status": "found",
            "checked_cpes": list(cpes),
            "cves": [{"id": "CVE-2024-0006", "description": "real match"}],
            "truncated": False,
            "errors": [],
            "note": "",
        }

    calls: list[Any] = []

    async def _search(
        keywords: Any, client: Any = None, per_keyword: Any = None
    ) -> Any:
        calls.append(keywords)
        return _rows_payload([])

    monkeypatch.setattr(orchestrator.nvd_service, "enrich_cpes", _enrich)
    monkeypatch.setattr(orchestrator.nvd_service, "search_keywords", _search)

    results, _ = await orchestrator.gather_results("example.com", force=True)

    assert results["nvd"]["status"] == "found"
    assert calls == [], "a found CPE result must never be replaced by keyword leads"


@pytest.mark.asyncio
async def test_keyword_fallback_does_not_run_when_nvd_is_unreachable(
    monkeypatch, stub_sources
):
    """An NVD outage must stay an outage, not become a result.

    Regression: the fallback overwrote `status: "unavailable"` with keyword
    leads, which dressed an infrastructure failure up as a scan result and lost
    the `errors[]` entry explaining why the card is thin. It is also pointless —
    the keyword search queries the same NVD host, so it could only add a second,
    redundant failure.
    """
    calls: list[Any] = []

    async def _search(
        keywords: Any, client: Any = None, per_keyword: Any = None
    ) -> Any:
        calls.append(keywords)
        return _rows_payload(
            [{"id": "CVE-2024-0008", "tier": "unverified", "keyword_derived": True}]
        )

    monkeypatch.setattr(
        orchestrator.shodan_service,
        "lookup",
        lambda *a, **k: _async(
            _shodan_payload(cpes=["cpe:2.3:a:nginx:nginx:1.25:*:*:*:*:*:*:*"])
        ),
    )

    async def _unavailable(cpes: Any, client: Any = None, **kwargs: Any) -> Any:
        return {
            "source": "NVD",
            "status": "unavailable",
            "checked_cpes": list(cpes or []),
            "cves": [],
            "truncated": False,
            "errors": ["NVD timed out after 12s"],
            "note": "NVD unreachable.",
        }

    monkeypatch.setattr(orchestrator.nvd_service, "enrich_cpes", _unavailable)
    monkeypatch.setattr(orchestrator.nvd_service, "search_keywords", _search)

    results, errors = await orchestrator.gather_results("example.com", force=True)

    assert calls == [], "the same host that just failed must not be retried"
    assert results["nvd"]["status"] == "unavailable"
    assert results["nvd"]["errors"] == ["NVD timed out after 12s"]
    assert any(e["source"] == "nvd" for e in errors)


@pytest.mark.asyncio
async def test_keyword_crash_never_fails_the_scan(monkeypatch, stub_sources):
    async def _boom(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("keyword search exploded")

    monkeypatch.setattr(orchestrator.nvd_service, "search_keywords", _boom)

    results, _errors = await orchestrator.gather_results("example.com", force=True)

    assert "shodan" in results
    assert results["nvd"]["status"] == "unavailable"
    # Only the exception TYPE is surfaced; a message can carry upstream text.
    assert "exploded" not in str(results)


@pytest.mark.asyncio
async def test_history_still_runs_because_keyword_leads_are_not_cve_evidence(
    monkeypatch, stub_sources
):
    """Documented behaviour: keyword leads do NOT suppress the history fallback.

    The history chain exists to answer "NVD gave us nothing usable". A keyword
    hit is a *lead*, not evidence about this host — it is precisely the "nothing
    usable" case the fallback was built for, so the two coexist by design.
    Pinning it here because it looks like a bug until you read the trigger.
    """
    calls: list[Any] = []

    async def _search(
        keywords: Any, client: Any = None, per_keyword: Any = None
    ) -> Any:
        return _rows_payload(
            [{"id": "CVE-2024-0007", "tier": "unverified", "keyword_derived": True}]
        )

    for name in ("otx", "urlscan", "leaklookup"):

        async def _spy(target: str, client: Any = None, _n: str = name) -> Any:
            calls.append(_n)
            return {
                "source": _n,
                "status": "ok",
                "count": 0,
                "findings": [],
                "truncated": False,
                "note": "",
            }

        monkeypatch.setattr(getattr(orchestrator, f"{name}_service"), "lookup", _spy)
    monkeypatch.setattr(orchestrator.nvd_service, "search_keywords", _search)

    results, _ = await orchestrator.gather_results("example.com", force=True)

    assert results["nvd"]["status"] == "keyword_derived"
    assert calls == [
        "otx",
        "urlscan",
        "leaklookup",
    ], "history supplements leads, it does not compete"
