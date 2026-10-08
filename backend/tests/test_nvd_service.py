"""NVD service tests: exact-CPE filtering, 404 mapping, failure modes.

Plus the keyword-search fallback (`search_keywords`), which only ever reports
leads. No live NVD traffic: the fallback tests run against `respx` with the real
endpoint string, so an unmatched route raises instead of escaping the suite.
"""

from __future__ import annotations

import httpx
import pytest
import respx

from app.core import cache as cache_mod
from app.core.config import settings
from app.services import nvd_service

APACHE = "cpe:2.3:a:apache:http_server:2.4.49:*:*:*:*:*:*:*"


def _vuln(cve_id, criteria, vulnerable=True, extra_match=None, metrics=None):
    match = {"vulnerable": vulnerable, "criteria": criteria}
    if extra_match:
        match.update(extra_match)
    cve = {
        "id": cve_id,
        "descriptions": [{"lang": "en", "value": f"desc {cve_id}"}],
        "configurations": [{"nodes": [{"negate": False, "cpeMatch": [match]}]}],
        "references": [],
    }
    if metrics is not None:
        cve["metrics"] = metrics
    return {"cve": cve}


class _Resp:
    def __init__(self, status=200, payload=None):
        self.status_code = status
        self._payload = payload if payload is not None else {}

    def json(self):
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


class _Client:
    def __init__(self, responses):
        self._responses = list(responses)
        self.calls = []

    async def get(self, url, params=None, headers=None, timeout=None):
        self.calls.append({"url": url, "params": params, "headers": headers})
        item = self._responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    async def aclose(self):
        return None


@pytest.fixture
def no_cache(monkeypatch):
    async def _get(key):
        return None

    async def _set(*a, **k):
        return None

    async def _sleep(*a, **k):
        return None

    monkeypatch.setattr(cache_mod, "cache_get_async", _get)
    monkeypatch.setattr(cache_mod, "cache_set_async", _set)
    monkeypatch.setattr(nvd_service.asyncio, "sleep", _sleep)


def _metrics(score, severity):
    return {
        "cvssMetricV31": [{"cvssData": {"baseScore": score, "baseSeverity": severity}}]
    }


@pytest.fixture(scope="session")
def nvd_client():
    """One real httpx client for the whole module, for `respx` to intercept.

    Handing the service an explicit client (which it never closes, because it
    only closes clients it created itself) keeps these tests fast: building an
    `httpx.AsyncClient` loads the OS CA bundle, which costs ~0.5s a call on
    Windows. What is under test is unchanged.

    Deliberately not closed on teardown: `respx` intercepts every request, so
    no socket is ever opened, and the per-test event loops this client was
    borrowed from are already closed by then — closing from a fresh loop would
    raise instead of cleaning up.
    """
    return httpx.AsyncClient(timeout=5.0)


# --- keyword-search fixtures -------------------------------------------------
#
# A real `?keywordSearch=` response: no `configurations` (keywordSearch matches
# prose, so there is nothing to match a CPE against), a `vulnStatus`, and the
# metrics block nested one level deeper than the CPE fixtures use.


def _kw_cve(
    cve_id,
    *,
    score=7.5,
    severity="HIGH",
    status="Analyzed",
    description=None,
    with_id=True,
):
    cve = {
        "published": "2023-04-05T14:15:00.000",
        "vulnStatus": status,
        "descriptions": (
            []
            if description is None and not with_id
            else [
                {
                    "lang": "en",
                    "value": description
                    or f"A flaw in a component related to {cve_id} prose.",
                }
            ]
        ),
        "metrics": {
            "cvssMetricV31": [
                {
                    "type": "Primary",
                    "cvssData": {
                        "baseScore": score,
                        "baseSeverity": severity,
                        "vectorString": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N",
                    },
                }
            ]
        },
        "references": [{"url": f"https://example.com/advisory/{cve_id}"}],
    }
    if with_id:
        cve["id"] = cve_id
    return {"cve": cve}


def _kw_payload(*cve_ids, total=None, **kwargs):
    vulns = [_kw_cve(cid, **kwargs) for cid in cve_ids]
    payload = {
        "resultsPerPage": len(vulns),
        "startIndex": 0,
        "vulnerabilities": vulns,
    }
    if total is not None:
        payload["totalResults"] = total
    return payload


def _kw_route(*responses):
    """Route the real NVD endpoint, one queued response per expected call.

    An unexpected extra call raises inside respx instead of reaching NVD, and
    `route.calls` records exactly what was asked for.
    """
    return respx.get(nvd_service.BASE).mock(side_effect=list(responses))


def _searched_terms(route):
    """The keywordSearch values actually sent to NVD, in call order."""
    return [call.request.url.params.get("keywordSearch") for call in route.calls]


@pytest.mark.asyncio
async def test_exact_match_kept_non_vulnerable_dropped(no_cache):
    payload = {
        "vulnerabilities": [
            _vuln("CVE-2021-41773", APACHE, True, metrics=_metrics(9.8, "CRITICAL")),
            _vuln("CVE-2007-4723", APACHE, False),
        ]
    }
    out = await nvd_service.enrich_cpes([APACHE], client=_Client([_Resp(200, payload)]))
    assert out["status"] == "found"
    assert [c["id"] for c in out["cves"]] == ["CVE-2021-41773"]
    assert out["cves"][0]["cvss"] == 9.8
    assert out["cves"][0]["severity"] == "CRITICAL"


@pytest.mark.asyncio
async def test_version_range_match_and_mismatch(no_cache):
    in_range = _vuln(
        "CVE-2024-0001",
        "cpe:2.3:a:apache:http_server:2.4.50:*:*:*:*:*:*:*",
        True,
        {"versionStartIncluding": "2.4.0", "versionEndIncluding": "2.4.49"},
    )
    out = await nvd_service.enrich_cpes(
        [APACHE], client=_Client([_Resp(200, {"vulnerabilities": [in_range]})])
    )
    assert out["status"] == "found"
    out_of_range = _vuln(
        "CVE-2024-0002",
        "cpe:2.3:a:apache:http_server:2.4.50:*:*:*:*:*:*:*",
        True,
        {"versionStartIncluding": "2.4.50"},
    )
    out = await nvd_service.enrich_cpes(
        [APACHE], client=_Client([_Resp(200, {"vulnerabilities": [out_of_range]})])
    )
    assert out["status"] == "no_match"


@pytest.mark.asyncio
async def test_404_empty_body_is_no_match_not_error(no_cache):
    out = await nvd_service.enrich_cpes(
        [APACHE], client=_Client([_Resp(404, ValueError("no json"))])
    )
    assert out["status"] == "no_match"
    assert out["cves"] == []
    assert out["errors"] == []


@pytest.mark.asyncio
async def test_timeout_is_unavailable(no_cache):
    err = httpx.ConnectTimeout("slow", request=httpx.Request("GET", nvd_service.BASE))
    out = await nvd_service.enrich_cpes([APACHE], client=_Client([err]))
    assert out["status"] == "unavailable"
    assert out["cves"] == []
    assert out["errors"] and "timed out" in out["errors"][0]


@pytest.mark.asyncio
async def test_invalid_cpe_rejected_without_network(no_cache):
    out = await nvd_service.enrich_cpes(["apache 2.4.49", "cpe:1.2:o:foo", None, 42])
    assert out["status"] == "insufficient_evidence"
    assert out["checked_cpes"] == []


@pytest.mark.asyncio
async def test_rate_limit_is_unavailable(no_cache):
    out = await nvd_service.enrich_cpes([APACHE], client=_Client([_Resp(429, {})]))
    assert out["status"] == "unavailable"


@pytest.mark.asyncio
async def test_max_cpes_cap(no_cache):
    cpes = [f"cpe:2.3:a:vendor:product:{i}:*:*:*:*:*:*:*" for i in range(10)]
    responses = [_Resp(200, {"vulnerabilities": []}) for _ in range(5)]
    client = _Client(responses)
    out = await nvd_service.enrich_cpes(cpes, client=client)
    assert len(out["checked_cpes"]) == 5
    assert len(client.calls) == 5


def test_shodan_preserves_valid_cpes_only():
    from app.services import shodan_service

    mapped = shodan_service._map_internetdb(
        {"ports": [80], "vulns": ["CVE-2025-1"], "cpes": [APACHE, "nginx 1.25", 42]},
        "1.1.1.1",
    )
    assert mapped["cpes"] == [APACHE]


def test_cpe_22_converted_to_23():
    from app.services.cpe_util import normalize_cpe

    assert normalize_cpe("cpe:/a:apache:http_server:2.4.49") == (
        "cpe:2.3:a:apache:http_server:2.4.49:*:*:*:*:*:*:*"
    )
    assert normalize_cpe("cpe:/o:linux:kernel") == (
        "cpe:2.3:o:linux:kernel:*:*:*:*:*:*:*:*"
    )
    # Deterministic 1-to-1: segments preserved, empties become wildcards.
    assert normalize_cpe("cpe:/a:vendor:product:1.0:update") == (
        "cpe:2.3:a:vendor:product:1.0:update:*:*:*:*:*:*"
    )
    assert normalize_cpe("cpe:/") is None
    assert normalize_cpe("apache") is None
    # CPE 2.3 passes through untouched.
    assert normalize_cpe(APACHE) == APACHE


def test_shodan_accepts_cpe_22_and_normalizes():
    from app.services import shodan_service

    mapped = shodan_service._map_internetdb(
        {"ports": [80], "vulns": [], "cpes": ["cpe:/a:apache:http_server:2.4.49"]},
        "1.1.1.1",
    )
    assert mapped["cpes"] == ["cpe:2.3:a:apache:http_server:2.4.49:*:*:*:*:*:*:*"]


@pytest.mark.asyncio
async def test_build_cve_rows_tiers(no_cache):
    # Shodan reports one ID that NVD says is Rejected and one ID NVD
    # returns for a *different* product (CPE mismatch) -> both excluded
    # from verified; a CPE-matched NVD row is verified.
    rejected_payload = {
        "vulnerabilities": [
            {
                "cve": {
                    "id": "CVE-2020-0001",
                    "vulnStatus": "Rejected",
                    "descriptions": [],
                    "configurations": [],
                    "metrics": {},
                }
            }
        ]
    }
    nvd_cves = [
        {
            "id": "CVE-2021-41773",
            "cvss": 9.8,
            "severity": "CRITICAL",
            "vuln_status": "Analyzed",
            "evidence_cpe": APACHE,
            "description": "x",
        }
    ]
    client = _Client(
        [_Resp(200, rejected_payload), _Resp(200, {"vulnerabilities": []})]
    )
    rows = await nvd_service.build_cve_rows(
        ["CVE-2021-41773", "CVE-2020-0001", "CVE-2022-9999"],
        {"status": "found", "cves": nvd_cves},
        client=client,
    )
    by_id = {r["id"]: r for r in rows}
    assert by_id["CVE-2021-41773"]["tier"] == "verified"
    assert by_id["CVE-2021-41773"]["source"] == "Shodan+NVD"
    assert by_id["CVE-2020-0001"]["tier"] == "rejected"
    # Unknown to NVD (empty vulnerabilities list) -> unverified, still present.
    assert by_id["CVE-2022-9999"]["tier"] == "unverified"
    assert by_id["CVE-2022-9999"]["url"].startswith("https://nvd.nist.gov/")


@pytest.mark.asyncio
async def test_build_cve_rows_nvd_total_failure_keeps_unverified(no_cache):
    rows = await nvd_service.build_cve_rows(
        ["CVE-2025-1", "CVE-2025-2"],
        {"status": "unavailable", "cves": []},
        client=None,
    )
    assert [r["tier"] for r in rows] == ["unverified", "unverified"]
    assert all(r["source"] == "Shodan" for r in rows)


@pytest.mark.asyncio
async def test_build_cve_rows_id_lookup_cap(no_cache):
    ids = [f"CVE-2024-{i:04d}" for i in range(30)]
    client = _Client([_Resp(200, {"vulnerabilities": []}) for _ in range(20)])
    rows = await nvd_service.build_cve_rows(
        ids, {"status": "no_match", "cves": []}, client=client
    )
    assert len(client.calls) == 20
    assert all(r["tier"] == "unverified" for r in rows)
    assert len(rows) == 30


@pytest.mark.asyncio
async def test_build_cve_rows_id_lookup_cached(no_cache, monkeypatch):
    store: dict = {}

    async def _get(key):
        return store.get(key)

    async def _set(key, payload, ttl):
        store[key] = payload

    monkeypatch.setattr(cache_mod, "cache_get_async", _get)
    monkeypatch.setattr(cache_mod, "cache_set_async", _set)
    payload = {
        "vulnerabilities": [
            {
                "cve": {
                    "id": "CVE-2024-1234",
                    "vulnStatus": "Analyzed",
                    "descriptions": [],
                    "configurations": [],
                    "metrics": {},
                }
            }
        ]
    }
    client1 = _Client([_Resp(200, payload)])
    rows1 = await nvd_service.build_cve_rows(
        ["CVE-2024-1234"], {"status": "no_match", "cves": []}, client=client1
    )
    assert len(client1.calls) == 1
    # Second run: cache hit, zero network.
    client2 = _Client([])
    rows2 = await nvd_service.build_cve_rows(
        ["CVE-2024-1234"], {"status": "no_match", "cves": []}, client=client2
    )
    assert len(client2.calls) == 0
    assert rows1[0]["tier"] == rows2[0]["tier"] == "unverified"


def test_risk_excludes_rejected_rows():
    from app.services import risk

    payload = {
        "shodan": {"ports": [80], "vulns": ["CVE-2020-0001", "CVE-2021-41773"]},
        "nvd": {
            "status": "found",
            "cves": [],
            "cve_rows": [
                {
                    "id": "CVE-2020-0001",
                    "tier": "rejected",
                    "severity": "CRITICAL",
                    "cvss": 10.0,
                },
                {
                    "id": "CVE-2021-41773",
                    "tier": "verified",
                    "severity": "CRITICAL",
                    "cvss": 9.8,
                },
            ],
        },
        "crtsh": {"count": 0},
    }
    _, breakdown = risk.score(payload)
    # Only the verified CRITICAL counts: vuln factor 1.0 from one row,
    # and the rejected row is reported separately, not scored.
    assert breakdown["vulns"] == 1.0
    assert breakdown["rejected_cves"] == 1.0
    payload_all_rejected = {
        "shodan": {"ports": [80], "vulns": ["CVE-2020-0001"]},
        "nvd": {
            "status": "found",
            "cves": [],
            "cve_rows": [{"id": "CVE-2020-0001", "tier": "rejected"}],
        },
        "crtsh": {"count": 0},
    }
    _, breakdown2 = risk.score(payload_all_rejected)
    assert breakdown2["vulns"] == 0.0
    assert breakdown2["rejected_cves"] == 1.0


def test_risk_merges_nvd_and_flags_incomplete():
    from app.services import risk

    payload = {
        "shodan": {"ports": [80], "vulns": ["CVE-2025-1"]},
        "nvd": {
            "status": "found",
            "cves": [{"id": "CVE-2021-41773", "cvss": 9.8, "severity": "CRITICAL"}],
        },
        "crtsh": {"count": 0},
    }
    score_full, breakdown = risk.score(payload)
    assert breakdown["vulns"] == 1.0
    assert "vulns_incomplete" not in breakdown
    # Same evidence set, but NVD coverage went missing: score keeps the
    # source-only value and flags the gap instead of silently dropping to 0.
    score_part, breakdown_part = risk.score(
        {
            "shodan": {"ports": [80], "vulns": ["CVE-2025-1"]},
            "nvd": {"status": "unavailable", "cves": []},
            "crtsh": {"count": 0},
        }
    )
    score_source_only, _ = risk.score(
        {"shodan": {"ports": [80], "vulns": ["CVE-2025-1"]}, "crtsh": {"count": 0}}
    )
    assert score_part == score_source_only
    assert score_part < score_full
    assert breakdown_part.get("vulns_incomplete") == 1.0


# ===========================================================================
# Keyword-search fallback (search_keywords)
#
# The centre of gravity is `test_keyword_cve_can_never_be_verified` plus the
# note assertions: keywordSearch matches CVE *descriptions*, so every hit is a
# lead. Anything that let one of these read as "this host is affected" — a
# `verified` tier, an `evidence_cpe`, a note without the caveat — is the bug
# this section exists to prevent.
# ===========================================================================


@pytest.mark.asyncio
async def test_keyword_search_labels_every_result(nvd_client, no_cache):
    payload = _kw_payload("CVE-2024-30051", "CVE-2024-38063", total=2)
    payload["vulnerabilities"][0]["cve"]["metrics"] = _metrics(9.8, "CRITICAL")
    payload["vulnerabilities"][1]["cve"]["metrics"] = _metrics(7.5, "HIGH")
    async with respx.mock:
        route = _kw_route(
            httpx.Response(200, json=payload),
            httpx.Response(200, json={"vulnerabilities": []}),
        )
        out = await nvd_service.search_keywords(["windows", "iis"], client=nvd_client)

    assert out["status"] == "keyword_derived"
    assert out["method"] == "keyword_search"
    assert out["source"] == "NVD"
    assert out["keywords"] == ["windows", "iis"]
    assert out["checked_cpes"] == []  # nothing CPE-shaped was checked
    assert out["errors"] == []
    # Sorted by severity, so the CRITICAL lead leads.
    assert [c["id"] for c in out["cves"]] == ["CVE-2024-30051", "CVE-2024-38063"]
    top = out["cves"][0]
    assert top["cvss"] == 9.8
    assert top["severity"] == "CRITICAL"
    assert top["vuln_status"] == "Analyzed"
    assert top["references"] == ["https://example.com/advisory/CVE-2024-30051"]
    # The two markers that keep this apart from a CPE match everywhere.
    assert top["keyword_derived"] is True
    assert top["evidence_cpe"] is None
    assert _searched_terms(route) == ["windows", "iis"]
    # Both terms went out through the documented parameter, asking for a page
    # rather than guessing at one.
    for call in route.calls:
        assert call.request.url.params.get("resultsPerPage") == "10"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payload",
    [
        _kw_payload("CVE-2024-30051", total=1),  # hits
        {"vulnerabilities": [], "totalResults": 0},  # nothing found
        {"vulnerabilities": []},  # count field absent too
    ],
)
async def test_keyword_note_always_carries_the_caveat(nvd_client, no_cache, payload):
    """Every emitted note says these are leads, not proof about this host.

    This is the test that pins the honesty requirement: a status change, a
    truncation or a new branch must never quietly produce a note that reads
    like a finding.
    """
    async with respx.mock:
        _kw_route(httpx.Response(200, json=payload))
        out = await nvd_service.search_keywords(["widget"], client=nvd_client)
    assert out["status"] == "keyword_derived"
    assert "not confirmation" in out["note"]
    assert "lead" in out["note"]
    assert len(out["note"]) <= nvd_service.NOTE_MAX_LEN


@pytest.mark.asyncio
@pytest.mark.parametrize("status_code", [404, 503, 429])
async def test_keyword_note_carries_the_caveat_on_failure(
    nvd_client, no_cache, status_code
):
    async with respx.mock:
        _kw_route(httpx.Response(status_code, json={}))
        out = await nvd_service.search_keywords(["widget"], client=nvd_client)
    assert out["status"] in ("keyword_derived", "unavailable")
    assert "not confirmation" in out["note"]
    assert "lead" in out["note"]


@pytest.mark.asyncio
async def test_keyword_cve_can_never_be_verified(nvd_client, no_cache):
    """Keyword-derived rows are capped at `unverified`, with no CPE evidence."""
    async with respx.mock:
        _kw_route(httpx.Response(200, json=_kw_payload("CVE-2024-30051", total=1)))
        nvd = await nvd_service.search_keywords(["windows"], client=nvd_client)
    rows = await nvd_service.build_cve_rows(["CVE-2024-30051"], nvd, client=nvd_client)
    assert {r["tier"] for r in rows} == {"unverified"}
    assert all(r["tier"] != "verified" for r in rows)
    for row in rows:
        assert row["evidence_cpe"] is None
        assert row["keyword_derived"] is True
        assert row["source"] == "NVD (keyword)"
        assert row["url"].startswith("https://nvd.nist.gov/")


@pytest.mark.asyncio
async def test_keyword_status_alone_still_blocks_verified(nvd_client, no_cache):
    """Second lock: strip the per-item marker and the status still refuses.

    `build_cve_rows` must not depend on one field surviving a rebuild or a
    forward; the result-level status is checked independently.
    """
    nvd = {
        "status": "keyword_derived",
        "method": "keyword_search",
        "cves": [
            {
                "id": "CVE-2024-30051",
                "cvss": 9.8,
                "severity": "CRITICAL",
                # A payload that lies about itself: CPE-looking evidence for a
                # keyword hit. It still must not be tiered verified.
                "evidence_cpe": APACHE,
                "vuln_status": "Analyzed",
            }
        ],
    }
    rows = await nvd_service.build_cve_rows([], nvd, client=nvd_client)
    assert rows[0]["tier"] == "unverified"
    assert rows[0]["evidence_cpe"] is None


@pytest.mark.asyncio
async def test_cpe_match_still_verified(nvd_client, no_cache):
    """The guard must not demote real CPE evidence: same file, other path."""
    nvd = {
        "status": "found",
        "cves": [
            {
                "id": "CVE-2021-41773",
                "cvss": 9.8,
                "severity": "CRITICAL",
                "evidence_cpe": APACHE,
                "vuln_status": "Analyzed",
            }
        ],
    }
    rows = await nvd_service.build_cve_rows([], nvd, client=nvd_client)
    assert rows[0]["tier"] == "verified"
    assert rows[0]["evidence_cpe"] == APACHE
    assert rows[0]["keyword_derived"] is False


@pytest.mark.asyncio
async def test_keyword_rejected_is_tiered_rejected(nvd_client, no_cache):
    """The existing rejected rule is reused verbatim for keyword hits."""
    async with respx.mock:
        _kw_route(
            httpx.Response(
                200, json=_kw_payload("CVE-2024-38063", total=1, status="Rejected")
            )
        )
        nvd = await nvd_service.search_keywords(["iis"], client=nvd_client)
    assert nvd["status"] == "keyword_derived"
    rows = await nvd_service.build_cve_rows([], nvd, client=nvd_client)
    assert rows[0]["tier"] == "rejected"
    assert rows[0]["keyword_derived"] is True
    from app.services import risk

    _, breakdown = risk.score({"nvd": {**nvd, "cve_rows": rows}, "crtsh": {}})
    assert breakdown["vulns"] == 0.0
    assert breakdown["rejected_cves"] == 1.0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payload",
    [
        {"vulnerabilities": [{"cve": {"id": "CVE-2024-1"}}]},  # no totalResults
        {"vulnerabilities": [{"cve": {"id": "CVE-2024-1"}}], "totalResults": "many"},
        {"vulnerabilities": "not-a-list"},
        {"vulnerabilities": [{"cve": {"descriptions": []}}]},  # no id
        {"vulnerabilities": [{"cve": {"id": "not-a-cve"}}]},
        {"vulnerabilities": [{"cve": None}, {}, None, "junk"]},
        {"vulnerabilities": [{"cve": {"id": "CVE-2024-1", "metrics": "junk"}}]},
        {"totalResults": 1},  # no vulnerabilities at all
        {"vulnerabilities": [{"cve": {"id": "CVE-2024-1", "vulnStatus": None}}]},
    ],
)
async def test_keyword_malformed_payload_never_raises(nvd_client, no_cache, payload):
    """NVD is untrusted: every shape below degrades, none of them raises."""
    async with respx.mock:
        _kw_route(httpx.Response(200, json=payload))
        out = await nvd_service.search_keywords(["widget"], client=nvd_client)
    assert out["status"] in ("keyword_derived", "unavailable", "insufficient_evidence")
    assert isinstance(out["cves"], list)
    assert all(isinstance(c["id"], str) for c in out["cves"])
    assert all(c["keyword_derived"] is True for c in out["cves"])
    assert "not confirmation" in out["note"]


@pytest.mark.asyncio
async def test_keyword_non_dict_payload_is_unavailable(nvd_client, no_cache):
    async with respx.mock:
        _kw_route(httpx.Response(200, json=["not", "a", "payload"]))
        out = await nvd_service.search_keywords(["widget"], client=nvd_client)
    assert out["status"] == "unavailable"
    assert out["errors"]
    assert "not confirmation" in out["note"]


@pytest.mark.asyncio
async def test_keyword_invalid_json_is_unavailable(nvd_client, no_cache):
    async with respx.mock:
        _kw_route(httpx.Response(200, content=b"<html>maintenance</html>"))
        out = await nvd_service.search_keywords(["widget"], client=nvd_client)
    assert out["status"] == "unavailable"
    assert out["errors"]
    assert out["cves"] == []


@pytest.mark.asyncio
async def test_keyword_no_matches_is_not_an_error(nvd_client, no_cache):
    """An empty search is an answer. It must not read as a failure."""
    async with respx.mock:
        route = _kw_route(
            httpx.Response(200, json={"vulnerabilities": [], "totalResults": 0})
        )
        out = await nvd_service.search_keywords(
            ["nothingmatchesthis"], client=nvd_client
        )
    assert out["status"] == "keyword_derived"
    assert out["cves"] == []
    assert out["errors"] == []
    assert out["truncated"] is False
    assert "found no CVE" in out["note"]
    assert _searched_terms(route) == ["nothingmatchesthis"]


@pytest.mark.asyncio
async def test_keyword_404_is_no_match_not_error(nvd_client, no_cache):
    """Same documented NVD behaviour as cpeName: 404 means nothing matched."""
    async with respx.mock:
        _kw_route(httpx.Response(404, content=b""))
        out = await nvd_service.search_keywords(["widget"], client=nvd_client)
    assert out["status"] == "keyword_derived"
    assert out["cves"] == []
    assert out["errors"] == []


@pytest.mark.asyncio
async def test_keyword_per_keyword_cap(nvd_client, no_cache):
    payload = _kw_payload("CVE-2024-1", "CVE-2024-2", "CVE-2024-3", total=42)
    async with respx.mock:
        route = _kw_route(httpx.Response(200, json=payload))
        out = await nvd_service.search_keywords(
            ["widget"], client=nvd_client, per_keyword=1
        )
    assert len(out["cves"]) == 1
    assert out["truncated"] is True
    # The page request is capped too: no point asking NVD for rows we drop.
    assert route.calls[0].request.url.params.get("resultsPerPage") == "1"


@pytest.mark.asyncio
async def test_keyword_hard_cap_across_terms(nvd_client, no_cache):
    per_term = 3
    responses = [
        httpx.Response(
            200,
            json=_kw_payload(
                *[f"CVE-2024-{term}{i}" for i in range(per_term + 1)], total=99
            ),
        )
        for term in ("a", "b", "c")
    ]
    async with respx.mock:
        route = _kw_route(*responses)
        out = await nvd_service.search_keywords(
            ["alpha", "beta", "gamma"], client=nvd_client, per_keyword=per_term
        )
    assert len(out["cves"]) == per_term * 3
    assert out["truncated"] is True
    assert _searched_terms(route) == ["alpha", "beta", "gamma"]


@pytest.mark.asyncio
async def test_keyword_count_cap_is_stated(nvd_client, no_cache):
    """More terms than the cap: search the first few and say so."""
    terms = ["nginx", "apache", "iis", "tomcat", "jetty", "weblogic"]
    async with respx.mock:
        route = _kw_route(
            *[httpx.Response(200, json={"vulnerabilities": []}) for _ in terms]
        )
        out = await nvd_service.search_keywords(terms, client=nvd_client)
    assert len(out["keywords"]) == nvd_service.MAX_KEYWORDS_DEFAULT
    assert _searched_terms(route) == terms[: nvd_service.MAX_KEYWORDS_DEFAULT]
    assert out["truncated"] is True
    # Saying so is part of the contract, not a nicety.
    assert f"Searched {nvd_service.MAX_KEYWORDS_DEFAULT} of {len(terms)}" in out["note"]
    assert "not confirmation" in out["note"]


@pytest.mark.asyncio
async def test_keyword_cap_setting_is_honoured(nvd_client, no_cache, monkeypatch):
    """`nvd_max_keywords` is read defensively: absent -> module default, set ->
    honoured. Written against `__dict__` because pydantic rejects unknown
    fields; `monkeypatch` restores it after the test.
    """
    monkeypatch.setitem(settings.__dict__, "nvd_max_keywords", 1)
    terms = ["nginx", "apache", "iis"]
    async with respx.mock:
        route = _kw_route(
            *[httpx.Response(200, json={"vulnerabilities": []}) for _ in terms]
        )
        out = await nvd_service.search_keywords(terms, client=nvd_client)
    assert len(route.calls) == 1
    assert _searched_terms(route) == ["nginx"]
    assert out["keywords"] == ["nginx"]
    assert "Searched 1 of 3" in out["note"]


@pytest.mark.asyncio
async def test_keyword_duplicate_terms_searched_once(nvd_client, no_cache):
    async with respx.mock:
        route = _kw_route(httpx.Response(200, json={"vulnerabilities": []}))
        out = await nvd_service.search_keywords(
            ["Nginx", "nginx", "NGINX", "  nginx  "], client=nvd_client
        )
    assert len(route.calls) == 1
    assert out["keywords"] == ["Nginx"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "bad", [None, [], "", "   ", "2.4.49", [None, 42, {"a": 1}], 42, {}, set()]
)
async def test_keyword_no_usable_term_never_touches_network(nvd_client, no_cache, bad):
    """Nothing usable to search -> nothing sent, and still caveated."""
    for _ in range(2):
        out = await nvd_service.search_keywords(bad, client=nvd_client)
        assert out["status"] == "insufficient_evidence"
        assert out["keywords"] == []
        assert out["cves"] == []
        assert out["errors"] == []
        assert "not confirmation" in out["note"]


@pytest.mark.asyncio
async def test_keyword_timeout_is_unavailable(nvd_client, no_cache):
    async with respx.mock:
        respx.get(nvd_service.BASE).mock(
            side_effect=httpx.ReadTimeout("slow", request=httpx.Request("GET", "x"))
        )
        out = await nvd_service.search_keywords(["widget"], client=nvd_client)
    assert out["status"] == "unavailable"
    assert out["cves"] == []
    assert out["errors"] and "timed out" in out["errors"][0]
    assert "not confirmation" in out["note"]


@pytest.mark.asyncio
@pytest.mark.parametrize("status_code", [403, 429, 500])
async def test_keyword_http_error_is_unavailable(nvd_client, no_cache, status_code):
    async with respx.mock:
        _kw_route(httpx.Response(status_code, json={}))
        out = await nvd_service.search_keywords(["widget"], client=nvd_client)
    assert out["status"] == "unavailable"
    assert out["cves"] == []
    assert out["errors"]
    assert "not confirmation" in out["note"]


@pytest.mark.asyncio
async def test_keyword_partial_failure_keeps_what_it_found(nvd_client, no_cache):
    """One term rate-limited, one term fine: results stay, and say they're thin."""
    async with respx.mock:
        _kw_route(
            httpx.Response(429, json={}),
            httpx.Response(200, json=_kw_payload("CVE-2024-30051", total=1)),
        )
        out = await nvd_service.search_keywords(["alpha", "beta"], client=nvd_client)
    assert out["status"] == "keyword_derived"
    assert [c["id"] for c in out["cves"]] == ["CVE-2024-30051"]
    assert out["errors"]
    assert "partial" in out["note"]
    assert "not confirmation" in out["note"]


@pytest.mark.asyncio
async def test_keyword_cache_avoids_the_second_request(
    nvd_client, no_cache, monkeypatch
):
    """Same cache seam as the CPE path: `nvd:kw:<term>`, same TTL."""
    store: dict = {}

    async def _get(key):
        return store.get(key)

    async def _set(key, payload, ttl):
        store[key] = payload

    monkeypatch.setattr(cache_mod, "cache_get_async", _get)
    monkeypatch.setattr(cache_mod, "cache_set_async", _set)
    async with respx.mock:
        route = _kw_route(
            httpx.Response(200, json=_kw_payload("CVE-2024-30051", total=1))
        )
        first = await nvd_service.search_keywords(["windows"], client=nvd_client)
        assert len(route.calls) == 1
        assert "nvd:kw:windows" in store
        second = await nvd_service.search_keywords(["windows"], client=nvd_client)
    # respx reuses the route for the same URL: the count not moving is the test.
    assert len(route.calls) == 1
    assert [c["id"] for c in second["cves"]] == [c["id"] for c in first["cves"]]
    assert second["status"] == "keyword_derived"


@pytest.mark.asyncio
async def test_keyword_failure_is_not_cached(nvd_client, no_cache, monkeypatch):
    """A rate-limit blip must not poison the term for the full 7-day TTL."""
    store: dict = {}

    async def _get(key):
        return store.get(key)

    async def _set(key, payload, ttl):
        store[key] = payload

    monkeypatch.setattr(cache_mod, "cache_get_async", _get)
    monkeypatch.setattr(cache_mod, "cache_set_async", _set)
    async with respx.mock:
        route = _kw_route(
            httpx.Response(429, json={}),
            httpx.Response(200, json={"vulnerabilities": []}),
        )
        first = await nvd_service.search_keywords(["windows"], client=nvd_client)
        assert first["status"] == "unavailable"
        assert store == {}  # the failure itself is not cached
        second = await nvd_service.search_keywords(["windows"], client=nvd_client)
    # The failed term was retried over the wire rather than served from cache...
    assert len(route.calls) == 2
    assert second["status"] == "keyword_derived"
    # ...and the successful retry is cached.
    assert store["nvd:kw:windows"] == {"cves": [], "error": None}


@pytest.mark.asyncio
async def test_keyword_delay_is_honoured_between_terms(
    nvd_client, no_cache, monkeypatch
):
    """The 6s NVD spacing applies to keyword terms too."""
    slept: list[float] = []

    async def _sleep(seconds):
        slept.append(seconds)

    monkeypatch.setattr(nvd_service.asyncio, "sleep", _sleep)
    async with respx.mock:
        _kw_route(
            *[httpx.Response(200, json={"vulnerabilities": []}) for _ in range(3)]
        )
        await nvd_service.search_keywords(["alpha", "beta", "gamma"], client=nvd_client)
    # One sleep before every request after the first: the first term must not
    # pay a delay, and no term may go unspaced.
    assert len(slept) == 2
    expected = (
        nvd_service.REQUEST_DELAY_WITH_KEY_SECONDS
        if settings.nvd_api_key
        else nvd_service.REQUEST_DELAY_SECONDS
    )
    assert slept == [expected, expected]


@pytest.mark.asyncio
async def test_keyword_cache_hit_does_not_burn_a_delay(
    nvd_client, no_cache, monkeypatch
):
    """The 6s spacing exists between NVD requests, so a cached term skips it."""
    store: dict = {}

    async def _get(key):
        return store.get(key)

    async def _set(key, payload, ttl):
        store[key] = payload

    monkeypatch.setattr(cache_mod, "cache_get_async", _get)
    monkeypatch.setattr(cache_mod, "cache_set_async", _set)
    store["nvd:kw:alpha"] = {
        "cves": [_kw_cve("CVE-2024-1111")["cve"]],
        "error": None,
    }
    slept: list[float] = []

    async def _sleep(seconds):
        slept.append(seconds)

    monkeypatch.setattr(nvd_service.asyncio, "sleep", _sleep)
    async with respx.mock:
        route = _kw_route(httpx.Response(200, json={"vulnerabilities": []}))
        out = await nvd_service.search_keywords(["alpha", "beta"], client=nvd_client)
    assert len(route.calls) == 1  # only the uncached term went out
    assert slept == []  # nothing was sent before it, so nothing to space
    assert out["status"] == "keyword_derived"


@pytest.mark.asyncio
async def test_keyword_unexpected_failure_never_raises(
    nvd_client, no_cache, monkeypatch
):
    """A bug in here must degrade like a transport failure, not fail the scan."""

    async def _boom(*a, **k):
        raise RuntimeError("kaboom")

    monkeypatch.setattr(nvd_service, "_query_keyword", _boom)
    out = await nvd_service.search_keywords(["widget"], client=nvd_client)
    assert out["status"] == "unavailable"
    assert out["cves"] == []
    assert out["errors"] and "RuntimeError" in out["errors"][0]
    assert "not confirmation" in out["note"]


@pytest.mark.asyncio
async def test_keyword_truncates_untrusted_strings(nvd_client, no_cache):
    payload = {
        "vulnerabilities": [
            {
                "cve": {
                    "id": "CVE-2024-" + "9" * 200,
                    "vulnStatus": "Analyzed" * 50,
                    "descriptions": [
                        {"lang": "en", "value": "x" * 5000},
                        {"lang": "es", "value": "hola"},
                    ],
                    "references": [{"url": "https://example.com/" + "u" * 2000}],
                    "metrics": _metrics(9.8, "CRITICAL"),
                }
            }
        ]
    }
    async with respx.mock:
        _kw_route(httpx.Response(200, json=payload))
        out = await nvd_service.search_keywords(["w" * 500], client=nvd_client)
    row = out["cves"][0]
    assert len(row["id"]) <= 30
    assert len(row["description"]) <= nvd_service.DESCRIPTION_MAX_LEN
    assert len(row["vuln_status"]) <= 40
    assert len(row["references"][0]) <= 500
    assert len(out["keywords"][0]) <= nvd_service.KEYWORD_MAX_LEN


@pytest.mark.asyncio
async def test_keyword_derived_rows_do_not_upgrade_shodan_ids(nvd_client, no_cache):
    """Shodan listing the same ID does not turn a lead into CPE evidence."""
    async with respx.mock:
        _kw_route(httpx.Response(200, json=_kw_payload("CVE-2024-30051", total=1)))
        nvd = await nvd_service.search_keywords(["windows"], client=nvd_client)
    rows = await nvd_service.build_cve_rows(["CVE-2024-30051"], nvd, client=nvd_client)
    assert rows[0]["tier"] == "unverified"
    assert rows[0]["source"] == "NVD (keyword)"


def test_derive_keywords_drops_noise():
    """Banner text becomes product words, not a phrase NVD cannot match."""
    assert nvd_service.derive_keywords("Apache/2.4.49 (Ubuntu) Server") == [
        "apache",
        "ubuntu",
    ]
    assert nvd_service.derive_keywords("https://www.example.com") == []
    assert nvd_service.derive_keywords("nginx 1.25.3", limit=1) == ["nginx"]
    assert nvd_service.derive_keywords(["Microsoft-IIS/10.0", None, 42]) == [
        "microsoft",
        "iis",
    ]
    assert nvd_service.derive_keywords("nginx nginx apache") == ["nginx", "apache"]
    assert nvd_service.derive_keywords(None) == []
    assert nvd_service.derive_keywords(42) == []
    assert nvd_service.derive_keywords("nginx apache", limit=0) == []


def test_derive_keywords_respects_the_cap():
    terms = nvd_service.derive_keywords(
        "alpha bravo charlie delta echo foxtrot golf hotel india juliet"
    )
    assert len(terms) == nvd_service.MAX_KEYWORDS_DEFAULT
