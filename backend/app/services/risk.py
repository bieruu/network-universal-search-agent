"""Risk heuristic v1 (transparent, not a pentest verdict)."""
from __future__ import annotations

from typing import Any


def score(results: dict[str, Any]) -> tuple[int, dict[str, float]]:
    shodan = results.get("shodan") or {}
    ports = shodan.get("ports") or []
    vulns = shodan.get("vulns") or []
    crtsh = results.get("crtsh") or {}
    n_subs = crtsh.get("count", 0) or len(crtsh.get("subdomains") or [])

    n_ports = len(ports)
    open_factor = 1.0 if n_ports > 5 else (0.6 if n_ports >= 3 else (0.3 if n_ports >= 1 else 0.0))
    vuln_factor = 0.0
    text = " ".join(str(v) for v in vulns).lower()
    if vulns:
        vuln_factor = 0.4
        if "critical" in text:
            vuln_factor = 1.0
        elif "high" in text or len(vulns) >= 3:
            vuln_factor = 0.7
    tls_factor = 0.0  # placeholder: expired/old TLS detection in v2
    sub_factor = 1.0 if n_subs > 20 else (0.5 if n_subs > 5 else 0.0)

    total = min(100, round(15 * open_factor + 25 * vuln_factor + 10 * tls_factor + 10 * sub_factor))
    breakdown = {"open_ports": open_factor, "vulns": vuln_factor, "tls": tls_factor, "subdomains": sub_factor}
    return total, breakdown
