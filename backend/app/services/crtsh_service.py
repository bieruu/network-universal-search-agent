"""crt.sh subdomain enumeration with dedup + cap."""

from __future__ import annotations

import asyncio
from typing import Any

import httpx

from app.core.config import settings


async def lookup(
    target: str, client: httpx.AsyncClient | None = None
) -> dict[str, Any]:
    domain = target.lstrip("*.")
    url = "https://crt.sh/"
    own = client is None
    if own:
        client = httpx.AsyncClient(
            timeout=settings.scan_timeout_crtsh,
            headers={"User-Agent": "osint-dashboard/1.0"},
        )
    raw: Any = []
    try:
        # crt.sh is slow for large zones (e.g. discord.com) and flaps with
        # transient 502/503/504 under load; retry twice with a short backoff
        # before surfacing a friendly error.
        for attempt in range(3):
            try:
                r = await client.get(url, params={"q": f"%.{domain}", "output": "json"})
                r.raise_for_status()
                raw = r.json()
                break
            except (httpx.TimeoutException, TimeoutError) as e:
                if attempt < 2:
                    await asyncio.sleep(1.5 * (attempt + 1))
                    continue
                raise RuntimeError(
                    f"crt.sh timed out for {domain} (large zone) — retry with Re-scan"
                ) from e
            except httpx.HTTPStatusError as e:
                status = e.response.status_code if e.response is not None else None
                if status in (502, 503, 504) and attempt < 2:
                    await asyncio.sleep(1.5 * (attempt + 1))
                    continue
                raise RuntimeError(
                    f"crt.sh lookup failed (HTTP {status}) — crt.sh is temporarily unavailable, retry with Re-scan"
                ) from e
    finally:
        if own and client is not None:
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
    return {
        "domain": domain,
        "count": len(seen),
        "subdomains": list(seen.values())[:500],
    }
