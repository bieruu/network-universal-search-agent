"""NVD CVE enrichment from exact CPE 2.3 names (backend only).

Verified 2026-10-05 against live NVD API 2.0:
- `GET /rest/json/cves/2.0?cpeName=<exact CPE>` returns every CVE whose
  configurations *mention* that CPE, including `vulnerable=false` nodes
  (Apache httpd 2.4.49 fixture yielded 83 mentions).
- `&isVulnerable=true` returned a bare HTTP 404 for the same fixture, so its
  behaviour is not trusted: this service never sends `isVulnerable` and
  filters client-side to `vulnerable=true` configuration matches instead.
- NVD answers HTTP 404 with an empty body both when a page is out of range
  and when the queried CPE has zero associated CVEs, so 404 maps to
  `no_match`, never to a transport failure.

Keyword search (`search_keywords`) is a *fallback*, not a second opinion:
`enrich_cpes` still refuses to guess CVEs from keywords, and this module only
answers keyword queries when the CPE path produced nothing. NVD's
`keywordSearch` matches CVE **descriptions** — free text written by analysts —
not a product identity, so a hit means "a CVE whose text mentions this term
exists", which is a lead to investigate and nothing more. Those results are
therefore reported under their own status (`keyword_derived`), carry no
`evidence_cpe`, and are hard-capped at `unverified` in `build_cve_rows`: they
can never be presented as "this host is affected".
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any

import httpx

from app.core import cache as cache_mod
from app.core.config import settings
from app.services.cpe_util import normalize_cpe

BASE = "https://services.nvd.nist.gov/rest/json/cves/2.0"
log = logging.getLogger(__name__)

MAX_CPES_DEFAULT = 5
CVES_PER_CPE_DEFAULT = 20
PAGE_SIZE = 50
REQUEST_DELAY_SECONDS = 6.0
REQUEST_DELAY_WITH_KEY_SECONDS = 0.7
CPE_CACHE_TTL_SECONDS = 7 * 24 * 3600

# --- keyword-search fallback -------------------------------------------------
# Status and method markers. `keyword_derived` is deliberately a status the CPE
# path can never emit, so no consumer can mistake a text mention for a CPE
# match; `build_cve_rows` also refuses to tier these rows `verified`.
KEYWORD_STATUS = "keyword_derived"
KEYWORD_METHOD = "keyword_search"
KEYWORD_CACHE_PREFIX = "nvd:kw:"
KEYWORD_ROW_SOURCE = "NVD (keyword)"
# Small on purpose: every term is one more rate-limited NVD request, and the
# endpoint is the one users hit hardest. Three terms is a lead generator, not a
# search engine.
MAX_KEYWORDS_DEFAULT = 3
CVES_PER_KEYWORD_DEFAULT = 10
# Absolute ceiling on one keyword's page size, whatever a caller passes.
MAX_CVES_PER_KEYWORD_CEILING = 25
KEYWORD_MAX_LEN = 100
KEYWORD_MIN_LEN = 2
# Minimum letters for a token promoted out of banner text by derive_keywords.
KEYWORD_MIN_WORDS = 3
# Function words and URL scaffolding: they match prose everywhere, so they
# return noise while still costing a rate-limited request.
KEYWORD_STOPWORDS = frozenset(
    {
        "the",
        "and",
        "for",
        "with",
        "this",
        "that",
        "from",
        "www",
        "http",
        "https",
        "com",
        "net",
        "org",
        "html",
        "example",
        "version",
        "server",
        "product",
        "software",
        "unknown",
        "none",
        "null",
    }
)
DESCRIPTION_MAX_LEN = 300
NOTE_MAX_LEN = 300
# Appended verbatim to every note this fallback emits, and never truncated away
# (`_keyword_note` reserves its space first). This is the honesty contract: a
# keyword hit is a lead, not a finding about this host.
KEYWORD_CAVEAT = (
    "Keyword-derived: these CVEs are ones whose NVD description mentions the "
    "searched term — not confirmation this host is affected. Treat each as a "
    "lead to investigate."
)


def _valid_cpe(value: Any) -> str | None:
    return normalize_cpe(value)


def _unique_cpes(raw: Any, limit: int) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    candidates = raw if isinstance(raw, (list, tuple)) else []
    for item in candidates:
        cleaned = _valid_cpe(item)
        if cleaned and cleaned not in seen:
            seen.add(cleaned)
            out.append(cleaned)
            if len(out) >= max(limit, 0):
                break
    return out


def _cpe_parts(cpe: str) -> list[str]:
    return cpe.split(":")


def _version_of(cpe: str) -> str:
    parts = _cpe_parts(cpe)
    return parts[5] if len(parts) > 5 else ""


def _same_product(criteria: str, cpe: str) -> bool:
    a = _cpe_parts(criteria)
    b = _cpe_parts(cpe)
    if len(a) < 5 or len(b) < 5:
        return False
    # part(2)=a/o/h, vendor(3), product(4) must match exactly.
    return a[2:5] == b[2:5]


def _parse_version(value: str) -> tuple[int | str, ...] | None:
    text = str(value or "").strip()
    if not text or text in {"*", "-"}:
        return None
    chunks: list[int | str] = []
    for chunk in text.replace("-", ".").split("."):
        chunk = chunk.strip()
        if not chunk:
            continue
        chunks.append(int(chunk) if chunk.isdigit() else chunk.lower())
    return tuple(chunks) or None


def _compare_versions(left: str, right: str) -> int | None:
    lv = _parse_version(left)
    rv = _parse_version(right)
    if lv is None or rv is None:
        return None
    for a, b in zip(lv, rv):
        if a == b:
            continue
        if isinstance(a, int) and isinstance(b, int):
            return -1 if a < b else 1
        return -1 if str(a) < str(b) else 1
    if len(lv) == len(rv):
        return 0
    return -1 if len(lv) < len(rv) else 1


def _in_range(version: str, match: dict[str, Any]) -> bool | None:
    """Check NVD versionStart/End bounds. None = cannot decide."""
    if not version or version in {"*", "-"}:
        return None
    decided = False
    for key, want_ge in (
        ("versionStartIncluding", True),
        ("versionStartExcluding", False),
        ("versionEndIncluding", True),
        ("versionEndExcluding", False),
    ):
        bound = match.get(key)
        if bound is None or str(bound).strip() in {"", "*", "-"}:
            continue
        cmp = _compare_versions(version, str(bound))
        if cmp is None:
            return None
        if "Start" in key:
            ok = cmp > 0 or (want_ge and cmp == 0)
        else:
            ok = cmp < 0 or (want_ge and cmp == 0)
        if not ok:
            return False
        decided = True
    return True if decided else None


def _match_supports_cpe(match: Any, cpe: str) -> bool:
    if not isinstance(match, dict):
        return False
    if match.get("vulnerable") is not True:
        return False
    criteria = match.get("criteria")
    if not isinstance(criteria, str) or not criteria:
        return False
    if criteria == cpe:
        return True
    if not _same_product(criteria, cpe):
        return False
    # Same vendor/product but different version pinning: accept only when the
    # NVD-declared version range provably contains the observed version.
    decided = _in_range(_version_of(cpe), match)
    return decided is True


def _node_supports_cpe(node: Any, cpe: str) -> bool:
    if not isinstance(node, dict):
        return False
    if node.get("negate") is True:
        return False
    matches = node.get("cpeMatch")
    if not isinstance(matches, list):
        return False
    return any(_match_supports_cpe(m, cpe) for m in matches)


def _cve_supports_cpe(cve: Any, cpe: str) -> bool:
    configs = cve.get("configurations") if isinstance(cve, dict) else None
    if not isinstance(configs, list) or not configs:
        return False
    for config in configs:
        if not isinstance(config, dict):
            continue
        nodes = config.get("nodes")
        if not isinstance(nodes, list):
            continue
        if any(_node_supports_cpe(n, cpe) for n in nodes):
            return True
    return False


def _english_description(cve: dict[str, Any]) -> str:
    for item in cve.get("descriptions") or []:
        if isinstance(item, dict) and item.get("lang") == "en" and item.get("value"):
            return str(item["value"])[:2000]
    descs = cve.get("descriptions") or []
    if descs and isinstance(descs[0], dict):
        return str(descs[0].get("value") or "")[:2000]
    return ""


def _best_cvss(cve: dict[str, Any]) -> tuple[float | None, str | None]:
    metrics = cve.get("metrics") if isinstance(cve, dict) else None
    if not isinstance(metrics, dict):
        return None, None
    best: tuple[float | None, str | None] = (None, None)
    for key in ("cvssMetricV31", "cvssMetricV30", "cvssMetricV40", "cvssMetricV2"):
        entries = metrics.get(key)
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            data = (
                entry.get("cvssData") if isinstance(entry.get("cvssData"), dict) else {}
            )
            score = data.get("baseScore")
            try:
                score_f = float(score) if score is not None else None
            except (TypeError, ValueError):
                score_f = None
            severity = data.get("baseSeverity") or entry.get("baseSeverity")
            sev = str(severity).upper()[:20] if severity else None
            if score_f is not None and (best[0] is None or score_f > best[0]):
                best = (score_f, sev)
    return best


def _map_cve(item: Any, evidence_cpe: str) -> dict[str, Any] | None:
    cve = item.get("cve") if isinstance(item, dict) else None
    if not isinstance(cve, dict):
        return None
    cve_id = str(cve.get("id") or "")
    if not cve_id.startswith("CVE-"):
        return None
    if not _cve_supports_cpe(cve, evidence_cpe):
        return None
    score, severity = _best_cvss(cve)
    refs: list[str] = []
    for ref in (cve.get("references") or [])[:5]:
        if isinstance(ref, dict) and ref.get("url"):
            refs.append(str(ref["url"])[:500])
    return {
        "id": cve_id[:30],
        "description": _english_description(cve),
        "cvss": score,
        "severity": severity,
        "published": str(cve.get("published") or "")[:30],
        "references": refs,
        "evidence_cpe": evidence_cpe,
        "vuln_status": str(cve.get("vulnStatus") or "")[:40],
    }


async def _query_cpe(
    cpe: str,
    client: httpx.AsyncClient,
    limit: int,
    page_size: int,
) -> tuple[list[dict[str, Any]], str | None]:
    """Return (matched CVEs, error message or None)."""
    params: dict[str, Any] = {"cpeName": cpe, "resultsPerPage": page_size}
    headers: dict[str, str] = {}
    if settings.nvd_api_key:
        headers["apiKey"] = settings.nvd_api_key
    try:
        response = await client.get(
            BASE,
            params=params,
            headers=headers or None,
            timeout=settings.scan_timeout_nvd,
        )
    except (httpx.TimeoutException, TimeoutError) as e:
        return (
            [],
            f"NVD timed out after {settings.scan_timeout_nvd}s for {cpe}: {e}"[:300],
        )
    except httpx.HTTPError as e:
        return [], f"NVD lookup failed for {cpe}: {type(e).__name__}"[:300]
    if response.status_code == 404:
        # NVD 404 = empty result page for this CPE (verified 2026-10-05).
        try:
            payload = response.json()
        except ValueError:
            return [], None
        vulns = payload.get("vulnerabilities") if isinstance(payload, dict) else None
        if not vulns:
            return [], None
    if response.status_code in (403, 429):
        return [], f"NVD rate limited (HTTP {response.status_code}) — retry later"[:300]
    if response.status_code >= 400:
        return [], f"NVD lookup failed (HTTP {response.status_code})"[:300]
    try:
        payload = response.json()
    except ValueError as e:
        return [], f"NVD returned invalid JSON: {e}"[:300]
    if not isinstance(payload, dict):
        return [], "NVD returned an invalid response"[:300]
    matched: list[dict[str, Any]] = []
    for item in payload.get("vulnerabilities") or []:
        mapped = _map_cve(item, cpe)
        if mapped:
            matched.append(mapped)
            if len(matched) >= limit:
                break
    return matched, None


# Cap of per-ID Shodan × NVD cross-checks per scan (cache-first, 7d TTL).
CVE_ID_LOOKUP_CAP = 20
REJECTED_STATUSES = {"REJECTED", "DISPUTED"}


def _is_rejected_status(vuln_status: Any) -> bool:
    return str(vuln_status or "").strip().upper() in REJECTED_STATUSES


def _is_keyword_derived(cve: Any, nvd: dict[str, Any]) -> bool:
    """True when a CVE item came from the keyword-search fallback.

    Checked at BOTH levels on purpose. The per-item `keyword_derived` marker is
    what `search_keywords` stamps on every row it emits, and the result-level
    `status`/`method` is the belt to that braces: if a consumer rebuilds or
    forwards only part of the payload and the per-item marker is lost, the
    status still refuses to treat the rows as CPE evidence. Fails closed to
    "keyword-derived" whenever either signal is present.
    """
    if isinstance(cve, dict) and cve.get("keyword_derived") is True:
        return True
    return (
        str(nvd.get("status") or "") == KEYWORD_STATUS
        or str(nvd.get("method") or "") == KEYWORD_METHOD
    )


def _cve_id_cache_key(cve_id: str) -> str:
    return f"nvd:cve:{cve_id.lower()}"


async def _lookup_cve_id(
    cve_id: str, client: httpx.AsyncClient
) -> dict[str, Any] | None | str:
    """Return {status, cvss, severity, description, references} for one CVE,
    None when NVD has no record, or an error string on transport failure."""
    cached = await cache_mod.cache_get_async(_cve_id_cache_key(cve_id))
    if isinstance(cached, dict) and "outcome" in cached:
        return cached["outcome"]
    headers: dict[str, str] = {}
    if settings.nvd_api_key:
        headers["apiKey"] = settings.nvd_api_key
    try:
        response = await client.get(
            BASE,
            params={"cveId": cve_id},
            headers=headers or None,
            timeout=settings.scan_timeout_nvd,
        )
    except (httpx.TimeoutException, TimeoutError) as e:
        outcome: Any = f"NVD timed out for {cve_id}: {e}"[:300]
        return outcome
    except httpx.HTTPError as e:
        outcome = f"NVD lookup failed for {cve_id}: {type(e).__name__}"[:300]
        return outcome
    if response.status_code in (403, 429):
        return f"NVD rate limited (HTTP {response.status_code})"[:300]
    if response.status_code >= 400 and response.status_code != 404:
        return f"NVD lookup failed (HTTP {response.status_code})"[:300]
    try:
        payload = response.json()
    except ValueError:
        payload = {}
    vulns = payload.get("vulnerabilities") if isinstance(payload, dict) else None
    if not isinstance(vulns, list) or not vulns:
        outcome = None
    else:
        cve = vulns[0].get("cve") if isinstance(vulns[0], dict) else None
        if isinstance(cve, dict) and str(cve.get("id") or "") == cve_id:
            score, severity = _best_cvss(cve)
            refs: list[str] = []
            for ref in (cve.get("references") or [])[:5]:
                if isinstance(ref, dict) and ref.get("url"):
                    refs.append(str(ref["url"])[:500])
            outcome = {
                "vuln_status": str(cve.get("vulnStatus") or "")[:40],
                "cvss": score,
                "severity": severity,
                "description": _english_description(cve),
                "references": refs,
            }
        else:
            outcome = None
    await cache_mod.cache_set_async(
        _cve_id_cache_key(cve_id), {"outcome": outcome}, CPE_CACHE_TTL_SECONDS
    )
    return outcome


def _row(
    cve_id: str,
    *,
    tier: str,
    source: str,
    severity: Any = None,
    cvss: Any = None,
    evidence_cpe: Any = None,
    vuln_status: Any = None,
    description: Any = None,
    keyword_derived: bool = False,
) -> dict[str, Any]:
    return {
        "id": cve_id[:30],
        "tier": tier,
        "source": source,
        "severity": severity if isinstance(severity, str) else None,
        "cvss": cvss if isinstance(cvss, (int, float)) else None,
        "evidence_cpe": evidence_cpe if isinstance(evidence_cpe, str) else None,
        "vuln_status": str(vuln_status or "")[:40] or None,
        "description": str(description or "")[:2000] or None,
        "keyword_derived": keyword_derived,
        "url": f"https://nvd.nist.gov/vuln/detail/{cve_id}"[:120],
    }


async def build_cve_rows(
    shodan_vulns: Any,
    nvd_result: dict[str, Any] | None,
    client: httpx.AsyncClient | None = None,
    max_id_lookups: int = CVE_ID_LOOKUP_CAP,
) -> list[dict[str, Any]]:
    """Cross-verify Shodan × NVD per CVE ID and assign a validity tier.

    tier:
      verified   — NVD CPE-exact match, or ID cross-checked against NVD with
                   a non-rejected status
      unverified — valid-looking ID that NVD could not confirm (cap reached,
                   NVD down, or CPE mismatch), and EVERY keyword-derived row
                   (a description mentioning a term is not evidence about
                   this host, so it can never reach `verified`)
      rejected   — NVD vulnStatus Rejected/Disputed; shown but scores 0

    Never raises; on NVD total failure every Shodan ID degrades to
    `unverified` rather than disappearing.
    """
    rows: dict[str, dict[str, Any]] = {}
    nvd = nvd_result if isinstance(nvd_result, dict) else {}
    status = str(nvd.get("status") or "missing")
    lookup_budget = max(max_id_lookups, 0)

    for cve in nvd.get("cves") or []:
        if not isinstance(cve, dict):
            continue
        cve_id = str(cve.get("id") or "")
        if not cve_id.startswith("CVE-"):
            continue
        keyword_derived = _is_keyword_derived(cve, nvd)
        if _is_rejected_status(cve.get("vuln_status")):
            tier = "rejected"
        elif keyword_derived:
            # Hard honesty floor: keyword-derived rows are capped here no
            # matter what the payload claims. A keyword hit is a lead.
            tier = "unverified"
        else:
            tier = "verified"
        rows[cve_id] = _row(
            cve_id,
            tier=tier,
            source=KEYWORD_ROW_SOURCE if keyword_derived else "NVD",
            severity=cve.get("severity"),
            cvss=cve.get("cvss"),
            # Keyword search produced no CPE evidence; a stale CPE copied onto
            # the row would be the exact lie this fallback exists to avoid.
            evidence_cpe=None if keyword_derived else cve.get("evidence_cpe"),
            vuln_status=cve.get("vuln_status"),
            description=cve.get("description"),
            keyword_derived=keyword_derived,
        )

    shodan_ids: list[str] = []
    seen_ids: set[str] = set()
    for vuln in shodan_vulns or []:
        if isinstance(vuln, str) and vuln.startswith("CVE-") and vuln not in seen_ids:
            seen_ids.add(vuln)
            shodan_ids.append(vuln)

    own = client is None
    if own and shodan_ids and status != "unavailable" and status != "missing":
        client = httpx.AsyncClient(
            timeout=settings.scan_timeout_nvd,
            headers={"User-Agent": "osint-dashboard/1.0"},
        )
    try:
        for cve_id in shodan_ids:
            if cve_id in rows:
                # Keep the keyword-derived label: Shodan listing the same ID
                # does not upgrade a description mention into CPE evidence.
                if not rows[cve_id].get("keyword_derived"):
                    rows[cve_id]["source"] = "Shodan+NVD"
                continue
            if lookup_budget <= 0 or client is None or status == "unavailable":
                rows[cve_id] = _row(cve_id, tier="unverified", source="Shodan")
                continue
            outcome = await _lookup_cve_id(cve_id, client)
            lookup_budget -= 1
            if isinstance(outcome, dict):
                if _is_rejected_status(outcome.get("vuln_status")):
                    rows[cve_id] = _row(
                        cve_id,
                        tier="rejected",
                        source="Shodan",
                        severity=outcome.get("severity"),
                        cvss=outcome.get("cvss"),
                        vuln_status=outcome.get("vuln_status"),
                        description=outcome.get("description"),
                    )
                else:
                    # Valid in NVD but not CPE-matched here: cross-checked yet
                    # not provable against the observed CPE -> unverified.
                    rows[cve_id] = _row(
                        cve_id,
                        tier="unverified",
                        source="Shodan",
                        severity=outcome.get("severity"),
                        cvss=outcome.get("cvss"),
                        vuln_status=outcome.get("vuln_status"),
                        description=outcome.get("description"),
                    )
            else:
                # None (not in NVD) or an error string: never drop the row.
                rows[cve_id] = _row(cve_id, tier="unverified", source="Shodan")
    finally:
        if own and client is not None:
            await client.aclose()

    order = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3}
    out = sorted(
        rows.values(),
        key=lambda r: (
            order.get(str(r.get("severity") or "").upper(), 9),
            -(r.get("cvss") or -1),
            str(r.get("id")),
        ),
    )
    return out[:100]


async def enrich_cpes(
    raw_cpes: Any,
    client: httpx.AsyncClient | None = None,
    max_cpes: int | None = None,
    cves_per_cpe: int | None = None,
) -> dict[str, Any]:
    """Enrich exact CPEs via NVD. Never raises; failure -> status unavailable."""
    cap = settings.nvd_max_cpes if max_cpes is None else max_cpes
    per_cpe = settings.nvd_cves_per_cpe if cves_per_cpe is None else cves_per_cpe
    cpes = _unique_cpes(raw_cpes, cap)
    if not cpes:
        return {
            "source": "NVD",
            "status": "insufficient_evidence",
            "checked_cpes": [],
            "cves": [],
            "truncated": False,
            "errors": [],
            "note": "No valid CPE 2.3 identifiers observed; refusing to guess CVEs from keywords.",
        }
    own = client is None
    if own:
        client = httpx.AsyncClient(
            timeout=settings.scan_timeout_nvd,
            headers={"User-Agent": "osint-dashboard/1.0"},
        )
    assert client is not None
    delay = (
        REQUEST_DELAY_WITH_KEY_SECONDS
        if settings.nvd_api_key
        else REQUEST_DELAY_SECONDS
    )
    ttl = CPE_CACHE_TTL_SECONDS
    cves: list[dict[str, Any]] = []
    seen: set[str] = set()
    errors: list[str] = []
    truncated = False
    try:
        for index, cpe in enumerate(cpes):
            cache_key = f"nvd:cpe:{cpe.lower()}"
            cached = await cache_mod.cache_get_async(cache_key)
            if isinstance(cached, dict) and isinstance(cached.get("cves"), list):
                for item in cached["cves"]:
                    if isinstance(item, dict) and item.get("id") not in seen:
                        seen.add(str(item["id"]))
                        cves.append(item)
                if cached.get("error"):
                    errors.append(str(cached["error"])[:300])
                continue
            if index > 0:
                await asyncio.sleep(delay)
            matched, error = await _query_cpe(
                cpe, client, per_cpe, settings.nvd_page_size
            )
            await cache_mod.cache_set_async(
                cache_key, {"cves": matched, "error": error}, ttl
            )
            if error:
                errors.append(error)
                log.warning("nvd_cpe_failed cpe=%s err=%s", cpe, error[:120])
                continue
            for item in matched:
                if item["id"] not in seen:
                    seen.add(str(item["id"]))
                    cves.append(item)
        hard_cap = max(per_cpe, 1) * max(len(cpes), 1)
        if len(cves) > hard_cap:
            truncated = True
            cves = cves[:hard_cap]
        order = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3}
        cves.sort(
            key=lambda c: (
                order.get(str(c.get("severity") or "").upper(), 9),
                -(c.get("cvss") or -1),
                str(c.get("id")),
            )
        )
        if errors and not cves:
            status = "unavailable"
        elif cves:
            status = "found"
        else:
            status = "no_match"
        note = {
            "found": "CVEs matched by exact CPE configuration (vulnerable=true).",
            "no_match": "NVD returned no vulnerable-configuration match. Absence of a match is not proof the host is safe.",
            "unavailable": "NVD could not be reached for every checked CPE; counts are partial evidence, not zero.",
            "insufficient_evidence": "No valid CPE identifiers to check.",
        }[status]
        return {
            "source": "NVD",
            "status": status,
            "checked_cpes": cpes,
            "cves": cves,
            "truncated": truncated,
            "errors": errors[:10],
            "note": note,
        }
    finally:
        if own:
            await client.aclose()


# --------------------------------------------------------------------------
# Keyword-search fallback (status: keyword_derived)
#
# FALLBACK ONLY. `enrich_cpes` deliberately refuses to guess CVEs from keywords
# because keywordSearch matches free-text analyst descriptions, not a product
# identity: a hit means "some CVE's prose mentions this term", which is a lead
# to investigate and never evidence that this host is affected. Call this only
# when the CPE path produced nothing, and surface the returned `note`.
# --------------------------------------------------------------------------


def _int_setting(name: str, default: int, *, low: int) -> int:
    """Read an int setting defensively: absent or unusable -> the default."""
    try:
        return max(int(getattr(settings, name, default)), low)
    except (TypeError, ValueError):
        return default


def derive_keywords(raw: Any, limit: int | None = None) -> list[str]:
    """Turn loose banner/product text into keyword-search terms.

    NVD `keywordSearch` is a full-text match over CVE descriptions, so a whole
    banner is the worst possible query: it matches nothing, costs a rate-limited
    request, and teaches the user nothing. This splits the text into candidate
    product words instead, dropping function words, URL scaffolding and
    version-only tokens like "2.4.49".

    Pure derivation, no network. `limit` defaults to the keyword cap.
    """
    values = [raw] if isinstance(raw, str) else raw
    if not isinstance(values, (list, tuple, set)):
        return []
    cap = MAX_KEYWORDS_DEFAULT if limit is None else max(int(limit), 0)
    if cap <= 0:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for value in values:
        if not isinstance(value, str):
            continue
        # Split on every non-alphanumeric run first, so "2.4.49" becomes its own
        # token instead of being glued onto the product name in front of it.
        for word in re.findall(r"[a-z0-9]+", value.lower()):
            if len(word) < KEYWORD_MIN_WORDS:
                continue
            if word in KEYWORD_STOPWORDS:
                continue
            if not any(ch.isalpha() for ch in word):
                continue  # version-only token, e.g. "249"
            if word in seen:
                continue
            seen.add(word)
            out.append(word)
            if len(out) >= cap:
                return out
    return out


def _unique_keywords(raw: Any, limit: int) -> tuple[list[str], int]:
    """Bounded, de-duplicated keyword list + the number dropped by the cap.

    Returns `(terms, dropped)` so the caller can say out loud that terms were
    left unsearched instead of silently narrowing the scan.
    """
    out: list[str] = []
    seen: set[str] = set()
    dropped = 0
    cap = max(limit, 0)
    candidates = [raw] if isinstance(raw, str) else raw
    for item in candidates if isinstance(candidates, (list, tuple, set)) else []:
        if not isinstance(item, str):
            continue
        cleaned = " ".join(item.split())[:KEYWORD_MAX_LEN]
        if len(cleaned) < KEYWORD_MIN_LEN or not any(ch.isalpha() for ch in cleaned):
            continue
        key = cleaned.casefold()
        if key in seen:
            continue
        seen.add(key)
        if len(out) >= cap:
            dropped += 1
            continue
        out.append(cleaned)
    return out, dropped


def _map_keyword_cve(item: Any, keyword: str) -> dict[str, Any] | None:
    """Map one NVD vulnerability entry to a keyword-derived CVE row.

    No `evidence_cpe`: keywordSearch returns no configuration evidence at all,
    and inventing one would be the exact claim this fallback must not make.
    """
    cve = item.get("cve") if isinstance(item, dict) else None
    if not isinstance(cve, dict):
        return None
    cve_id = str(cve.get("id") or "")
    if not cve_id.startswith("CVE-"):
        return None
    score, severity = _best_cvss(cve)
    refs: list[str] = []
    for ref in (cve.get("references") or [])[:5]:
        if isinstance(ref, dict) and ref.get("url"):
            refs.append(str(ref["url"])[:500])
    return {
        "id": cve_id[:30],
        "description": _english_description(cve)[:DESCRIPTION_MAX_LEN],
        "cvss": score,
        "severity": severity,
        "published": str(cve.get("published") or "")[:30],
        "references": refs,
        "evidence_cpe": None,
        "keyword": keyword,
        "keyword_derived": True,
        "vuln_status": str(cve.get("vulnStatus") or "")[:40],
    }


async def _query_keyword(
    keyword: str,
    client: httpx.AsyncClient,
    limit: int,
    page_size: int,
) -> tuple[list[dict[str, Any]], str | None, bool]:
    """Return (mapped CVEs, error message or None, truncated) for one keyword."""
    params: dict[str, Any] = {
        "keywordSearch": keyword,
        "resultsPerPage": max(min(limit, page_size), 1),
    }
    headers: dict[str, str] = {}
    if settings.nvd_api_key:
        headers["apiKey"] = settings.nvd_api_key
    try:
        response = await client.get(
            BASE,
            params=params,
            headers=headers or None,
            timeout=settings.scan_timeout_nvd,
        )
    except (httpx.TimeoutException, TimeoutError) as e:
        return (
            [],
            f"NVD keyword search timed out after {settings.scan_timeout_nvd}s for {keyword!r}: {e}"[
                :300
            ],
            False,
        )
    except httpx.HTTPError as e:
        return (
            [],
            f"NVD keyword search failed for {keyword!r}: {type(e).__name__}"[:300],
            False,
        )
    if response.status_code == 404:
        # Same documented NVD behaviour as cpeName: 404 = nothing matched.
        return [], None, False
    if response.status_code in (403, 429):
        return (
            [],
            f"NVD rate limited (HTTP {response.status_code}) — retry later"[:300],
            False,
        )
    if response.status_code >= 400:
        return (
            [],
            f"NVD keyword search failed (HTTP {response.status_code})"[:300],
            False,
        )
    try:
        payload = response.json()
    except ValueError as e:
        return [], f"NVD returned invalid JSON for keyword search: {e}"[:300], False
    if not isinstance(payload, dict):
        return [], "NVD returned an invalid keyword-search response"[:300], False
    vulns = payload.get("vulnerabilities")
    if not isinstance(vulns, list):
        # Absent or wrongly-typed field: "nothing found", not invented rows.
        return [], None, False
    mapped: list[dict[str, Any]] = []
    truncated = False
    for item in vulns:
        if len(mapped) >= limit:
            truncated = True
            break
        row = _map_keyword_cve(item, keyword)
        if row:
            mapped.append(row)
    # `totalResults` is untrusted and may be absent or non-numeric; when it is
    # usable it says whether more matches exist upstream of this page.
    try:
        total = int(payload.get("totalResults"))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        total = None
    if total is not None and total > len(vulns):
        truncated = True
    return mapped, None, truncated


def _keyword_result(
    *,
    status: str,
    keywords: list[str],
    cves: list[dict[str, Any]],
    truncated: bool,
    errors: list[str],
    note: str,
) -> dict[str, Any]:
    return {
        "source": "NVD",
        "status": status,
        "method": KEYWORD_METHOD,
        "keywords": keywords,
        "checked_cpes": [],
        "cves": cves,
        "truncated": truncated,
        "errors": errors[:10],
        "note": note[:NOTE_MAX_LEN],
    }


def _keyword_note(
    status: str,
    *,
    empty: bool = False,
    partial: bool = False,
    dropped_terms: int = 0,
    searched: int = 0,
) -> str:
    """Build the note. The caveat is load-bearing and never truncated away."""
    if status == "unavailable":
        lead = (
            "NVD keyword search failed for every term; no keyword-derived "
            "CVEs. Partial evidence, not zero."
        )
    elif status == "insufficient_evidence":
        lead = "No usable keyword term to search; nothing was sent to NVD."
    elif empty:
        lead = (
            "Keyword search ran and found no CVE matching the term; absence "
            "is not proof the host is safe."
        )
    else:
        lead = (
            f"Keyword search over {searched} term(s) returned CVEs whose "
            "descriptions mention them."
        )
    extras: list[str] = []
    if dropped_terms:
        extras.append(f"Searched {searched} of {searched + dropped_terms} term(s).")
    if partial:
        extras.append("Some terms failed; results are partial.")
    parts = [lead]
    # Append extras only while they fit: the terms-dropped count is the one a
    # reader needs to trust the scope, but the caveat outranks both.
    for extra in extras:
        if len(" ".join([*parts, extra, KEYWORD_CAVEAT])) <= NOTE_MAX_LEN:
            parts.append(extra)
    note = " ".join([*parts, KEYWORD_CAVEAT])
    if len(note) > NOTE_MAX_LEN:
        keep = NOTE_MAX_LEN - len(KEYWORD_CAVEAT) - 1
        head = lead[: max(keep - 3, 0)].rsplit(" ", 1)[0]
        note = f"{head}... {KEYWORD_CAVEAT}"
    return note


async def search_keywords(
    keywords: Any,
    client: httpx.AsyncClient | None = None,
    per_keyword: int | None = None,
) -> dict[str, Any]:
    """Fallback NVD keyword search for targets with no CPE evidence.

    Use ONLY when `enrich_cpes` produced nothing. NVD `keywordSearch` matches
    CVE *descriptions* — analyst prose — not a product identity, so every row
    here is a lead to investigate, never a claim that this host is affected.
    The result says so itself: `status` is the distinct `keyword_derived`,
    `method` is `keyword_search`, `cves` carry `keyword_derived: True` and no
    `evidence_cpe`, and `build_cve_rows` caps them at `unverified`.

    Never raises: any transport, parse or shape failure degrades to the same
    `unavailable` shape the CPE path uses.
    """
    # `getattr` for both knobs: `Settings` has `extra="ignore"`, so the module
    # defaults stand until the matching config fields land (NEEDS INTEGRATION)
    # and take over the moment they do, with no change here.
    keyword_cap = _int_setting("nvd_max_keywords", MAX_KEYWORDS_DEFAULT, low=0)
    per_kw = (
        _int_setting("nvd_cves_per_keyword", CVES_PER_KEYWORD_DEFAULT, low=1)
        if per_keyword is None
        else per_keyword
    )
    limit = max(min(per_kw, MAX_CVES_PER_KEYWORD_CEILING), 1)
    terms, dropped_terms = _unique_keywords(keywords, keyword_cap)
    if not terms:
        return _keyword_result(
            status="insufficient_evidence",
            keywords=[],
            cves=[],
            truncated=False,
            errors=[],
            note=_keyword_note("insufficient_evidence"),
        )
    own = client is None
    if own:
        client = httpx.AsyncClient(
            timeout=settings.scan_timeout_nvd,
            headers={"User-Agent": "osint-dashboard/1.0"},
        )
    assert client is not None
    delay = (
        REQUEST_DELAY_WITH_KEY_SECONDS
        if settings.nvd_api_key
        else REQUEST_DELAY_SECONDS
    )
    cves: list[dict[str, Any]] = []
    seen: set[str] = set()
    errors: list[str] = []
    truncated = False
    try:
        sent = 0  # requests actually put on the wire this call
        for keyword in terms:
            cache_key = f"{KEYWORD_CACHE_PREFIX}{keyword.lower()}"
            cached = await cache_mod.cache_get_async(cache_key)
            if isinstance(cached, dict) and isinstance(cached.get("cves"), list):
                # NOTE: only successful lookups are cached. A rate-limit or
                # timeout blip must not poison the term for the full 7d TTL,
                # which is the opposite of what a retry would want.
                for item in cached["cves"]:
                    if isinstance(item, dict) and item.get("id") not in seen:
                        seen.add(str(item["id"]))
                        cves.append(item)
                continue
            # Space live requests, not terms: a cache hit in front of a request
            # must not burn 6s of the scan budget for nothing.
            if sent:
                await asyncio.sleep(delay)
            matched, error, kw_truncated = await _query_keyword(
                keyword, client, limit, settings.nvd_page_size
            )
            sent += 1
            if error:
                errors.append(error)
                log.warning("nvd_keyword_failed kw=%s err=%s", keyword, error[:120])
                continue
            await cache_mod.cache_set_async(
                cache_key, {"cves": matched, "error": None}, CPE_CACHE_TTL_SECONDS
            )
            truncated = truncated or kw_truncated
            for item in matched:
                if item["id"] not in seen:
                    seen.add(str(item["id"]))
                    cves.append(item)
        hard_cap = limit * max(len(terms), 1)
        if len(cves) > hard_cap:
            truncated = True
            cves = cves[:hard_cap]
        order = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3}
        cves.sort(
            key=lambda c: (
                order.get(str(c.get("severity") or "").upper(), 9),
                -(c.get("cvss") or -1),
                str(c.get("id")),
            )
        )
        # An empty keyword search is a real answer, not an error: we asked, and
        # no CVE description mentions the term. Only a total transport failure
        # is `unavailable` — and even that still carries the caveat.
        status = "unavailable" if errors and not cves else KEYWORD_STATUS
        return _keyword_result(
            status=status,
            keywords=terms,
            cves=cves,
            truncated=truncated or dropped_terms > 0,
            errors=errors,
            note=_keyword_note(
                status,
                empty=not cves,
                partial=bool(errors) and bool(cves),
                dropped_terms=dropped_terms,
                searched=len(terms),
            ),
        )
    except Exception as e:  # noqa: BLE001 — this fallback must never fail a scan
        log.warning(
            "nvd_keyword_search_crashed err=%s msg=%s",
            type(e).__name__,
            str(e)[:120],
        )
        return _keyword_result(
            status="unavailable",
            keywords=terms,
            cves=[],
            # Nothing was cut here; nothing came back at all. `truncated` is for
            # results we shortened, and the UI reads it as "we narrowed this".
            truncated=False,
            errors=[f"NVD keyword search failed: {type(e).__name__}"[:300]],
            note=_keyword_note("unavailable"),
        )
    finally:
        if own:
            await client.aclose()
