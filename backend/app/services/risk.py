"""Risk heuristic v1 (transparent, not a pentest verdict)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


def _cert_expiry_factor(crtsh: dict[str, Any]) -> float:
    subdomains = crtsh.get("subdomains") or []
    if not subdomains:
        return 0.0

    expired = 0
    near_expiry = 0
    for item in subdomains:
        if not isinstance(item, dict):
            continue
        not_after = item.get("not_after")
        if not not_after:
            continue
        try:
            expiry = datetime.fromisoformat(str(not_after).replace("Z", "+00:00"))
        except ValueError:
            continue
        if expiry.tzinfo is None:
            expiry = expiry.replace(tzinfo=timezone.utc)
        now = datetime.now(timezone.utc)
        age_days = (expiry - now).days
        if age_days <= 0:
            expired += 1
        elif age_days <= 30:
            near_expiry += 1

    if expired:
        return 1.0
    if near_expiry:
        return 0.7
    return 0.2


def _is_keyword_lead(item: dict[str, Any]) -> bool:
    """True when this NVD item came from keywordSearch rather than an exact CPE.

    Both signals are checked because either alone is insufficient: the item
    marker can be lost if a payload is rebuilt, and the result-level status is
    authoritative for the whole block.
    """
    nvd = item.get("_nvd_block")
    return bool(item.get("keyword_derived")) or bool(
        isinstance(nvd, dict) and nvd.get("status") == "keyword_derived"
    )


def _nvd_cves(results: dict[str, Any]) -> tuple[list[dict[str, Any]], str]:
    nvd = results.get("nvd")
    if not isinstance(nvd, dict):
        return [], "missing"
    cves = nvd.get("cves") if isinstance(nvd.get("cves"), list) else []
    keyword_only = nvd.get("status") == "keyword_derived"
    cleaned = []
    for c in cves:
        if not isinstance(c, dict) or not str(c.get("id") or "").startswith("CVE-"):
            continue
        # A keyword-derived CVE is a lead, not host evidence: NVD matched the
        # term inside a description, which says nothing about this host. It must
        # not enter the evidence set on the legacy (no cve_rows) path either.
        if keyword_only or c.get("keyword_derived"):
            continue
        cleaned.append(c)
    return cleaned, str(nvd.get("status") or "missing")


def _cve_rows(results: dict[str, Any]) -> tuple[list[dict[str, Any]] | None, str]:
    nvd = results.get("nvd")
    if not isinstance(nvd, dict):
        return None, "missing"
    rows = nvd.get("cve_rows")
    if isinstance(rows, list):
        cleaned = [
            r
            for r in rows
            if isinstance(r, dict) and str(r.get("id") or "").startswith("CVE-")
        ]
        return cleaned, str(nvd.get("status") or "missing")
    return None, str(nvd.get("status") or "missing")


def score(results: dict[str, Any]) -> tuple[int, dict[str, float]]:
    shodan = results.get("shodan") or {}
    ports = shodan.get("ports") or []
    vulns = shodan.get("vulns") or []
    nvd_cves, nvd_status = _nvd_cves(results)
    cve_rows, _rows_status = _cve_rows(results)
    crtsh = results.get("crtsh") or {}
    n_subs = crtsh.get("count", 0) or len(crtsh.get("subdomains") or [])

    n_ports = len(ports)
    open_factor = (
        1.0
        if n_ports > 5
        else (0.6 if n_ports >= 3 else (0.3 if n_ports >= 1 else 0.0))
    )
    vuln_factor = 0.0
    # Evidence set = Shodan/InternetDB vuln IDs + NVD exact-CPE matches.
    # Missing NVD data (unavailable/insufficient/missing) never reads as zero:
    # it keeps the source-only score and flags uncertainty in the breakdown.
    evidence_ids = {str(v) for v in vulns if str(v).startswith("CVE-")}
    nvd_severe = False
    rejected_count = 0
    keyword_derived_count = 0
    if cve_rows is not None:
        # Tiered path: only verified + unverified rows score; rejected rows
        # are excluded even when Shodan still lists the ID.
        evidence_ids = set()
        for row in cve_rows:
            tier = str(row.get("tier") or "")
            if tier == "rejected":
                rejected_count += 1
                continue
            if row.get("keyword_derived"):
                # A CVE whose NVD *description mentions* a term is a lead, not
                # evidence that this host is affected. Scoring it would let any
                # target reach a 100 on the strength of an unrelated CVE that
                # happens to share a word with its banner.
                keyword_derived_count += 1
                continue
            if tier in ("verified", "unverified"):
                evidence_ids.add(str(row["id"]))
                sev = str(row.get("severity") or "").upper()
                if sev == "CRITICAL":
                    nvd_severe = True
                try:
                    cvss = float(row["cvss"]) if row.get("cvss") is not None else None
                except (TypeError, ValueError):
                    cvss = None
                if cvss is not None and cvss >= 9.0:
                    nvd_severe = True
    else:
        for cve in nvd_cves:
            evidence_ids.add(str(cve.get("id")))
            sev = str(cve.get("severity") or "").upper()
            if sev == "CRITICAL":
                nvd_severe = True
            try:
                cvss = float(cve.get("cvss")) if cve.get("cvss") is not None else None
            except (TypeError, ValueError):
                cvss = None
            if cvss is not None and cvss >= 9.0:
                nvd_severe = True
    text = " ".join(sorted(evidence_ids)).lower()
    if evidence_ids:
        vuln_factor = 0.4
        if "critical" in text or nvd_severe:
            vuln_factor = 1.0
        elif "high" in text or len(evidence_ids) >= 3:
            vuln_factor = 0.7
    nvd_uncertain = nvd_status in (
        "unavailable",
        "insufficient_evidence",
        "missing",
        # Keyword hits are leads: coverage is NOT unknown, but the rows present
        # say nothing about this host, so the vuln component stays uncertain
        # rather than reading as "we checked and found nothing serious".
        "keyword_derived",
    )
    tls_factor = _cert_expiry_factor(crtsh)
    sub_factor = 1.0 if n_subs > 20 else (0.5 if n_subs > 5 else 0.0)

    total = min(
        100,
        round(15 * open_factor + 25 * vuln_factor + 10 * tls_factor + 10 * sub_factor),
    )
    breakdown = {
        "open_ports": open_factor,
        "vulns": vuln_factor,
        "tls": tls_factor,
        "subdomains": sub_factor,
    }
    if nvd_uncertain and (evidence_ids or rejected_count or keyword_derived_count):
        # Keep the score but record that CVE coverage was incomplete. Keyword
        # leads count here for the same reason: they are on screen, so the card
        # must not let the vuln component read as "we checked and it was fine".
        breakdown["vulns_incomplete"] = 1.0
    if rejected_count:
        breakdown["rejected_cves"] = float(rejected_count)
    if keyword_derived_count:
        # Surfaced so a consumer can show "N keyword leads, none counted toward
        # the score" rather than the vuln component quietly reading as zero.
        breakdown["keyword_leads"] = float(keyword_derived_count)
    return total, breakdown
