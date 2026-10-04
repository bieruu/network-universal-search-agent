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


def score(results: dict[str, Any]) -> tuple[int, dict[str, float]]:
    shodan = results.get("shodan") or {}
    ports = shodan.get("ports") or []
    vulns = shodan.get("vulns") or []
    crtsh = results.get("crtsh") or {}
    n_subs = crtsh.get("count", 0) or len(crtsh.get("subdomains") or [])

    n_ports = len(ports)
    open_factor = (
        1.0
        if n_ports > 5
        else (0.6 if n_ports >= 3 else (0.3 if n_ports >= 1 else 0.0))
    )
    vuln_factor = 0.0
    text = " ".join(str(v) for v in vulns).lower()
    if vulns:
        vuln_factor = 0.4
        if "critical" in text:
            vuln_factor = 1.0
        elif "high" in text or len(vulns) >= 3:
            vuln_factor = 0.7
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
    return total, breakdown
