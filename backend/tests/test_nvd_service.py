"""NVD service tests: exact-CPE filtering, 404 mapping, failure modes."""

from __future__ import annotations

import httpx
import pytest

from app.core import cache as cache_mod
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
