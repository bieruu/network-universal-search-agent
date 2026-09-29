"""crt.sh subdomain enumeration with dedup + cap."""
from __future__ import annotations

from typing import Any

import httpx

from app.core.config import settings


async def lookup(target: str, client: httpx.AsyncClient | None = None) -> dict[str, Any]:
    domain = target.lstrip("*.")
    url = "https://crt.sh/"
    own = client is None
    if own:
        client = httpx.AsyncClient(timeout=settings.scan_timeout_crtsh, headers={"User-Agent": "osint-dashboard/1.0"})
    try:
        r = await client.get(url, params={"q": f"%.{domain}", "output": "json"})
        r.raise_for_status()
        raw = r.json()
    finally:
        if own:
            await client.aclose()
    seen: dict[str, dict[str, Any]] = {}
    for row in (raw or [])[:500]:
        nv = str(row.get("name_value") or "")
        for name in nv.splitlines():
            n = name.strip().lower().lstrip("*.")
            if n and n not in seen:
                seen[n] = {
                    "subdomain": n[:253],
                    "issuer": str(row.get("issuer_name") or "")[:300],
                    "not_before": str(row.get("not_before") or "")[:40],
                    "not_after": str(row.get("not_after") or "")[:40],
                }
        if len(seen) >= 500:
            break
    return {"domain": domain, "count": len(seen), "subdomains": list(seen.values())[:500]}
