"""Shodan host lookup. Never called from browser; backend only."""

from __future__ import annotations

import socket
from typing import Any

import httpx

from app.core.config import settings

BASE = "https://api.shodan.io"


def _truncate(s: str, n: int = 2048) -> str:
    return s[:n] if isinstance(s, str) else ""


def _is_ip(target: str) -> bool:
    parts = target.split(".")
    return len(parts) == 4 and all(p.isdigit() for p in parts)


async def lookup(
    target: str, client: httpx.AsyncClient | None = None
) -> dict[str, Any]:
    if not settings.shodan_api_key:
        raise RuntimeError("SHODAN_API_KEY not configured")
    ip = target
    if not _is_ip(target):
        try:
            ip = socket.gethostbyname(target)
        except OSError as e:
            raise RuntimeError(f"DNS resolve failed: {e}") from e
    url = f"{BASE}/shodan/host/{ip}"
    own = client is None
    if own:
        client = httpx.AsyncClient(
            timeout=settings.scan_timeout_shodan,
            headers={"User-Agent": "osint-dashboard/1.0"},
        )
    try:
        r = await client.get(url, params={"key": settings.shodan_api_key})
        r.raise_for_status()
        raw = r.json()
    except httpx.HTTPStatusError as e:
        status = e.response.status_code if e.response is not None else None
        if status == 403:
            raise RuntimeError(
                f"Shodan has no data for {ip} (likely CDN/WAF IP) or plan limit (HTTP 403)"
            ) from e
        if status == 404:
            raise RuntimeError(f"Shodan has no record for {ip} (HTTP 404)") from e
        if status == 401:
            raise RuntimeError("Shodan API key invalid (HTTP 401)") from e
        raise RuntimeError(f"Shodan lookup failed (HTTP {status})") from e
    finally:
        if own:
            await client.aclose()
    ports: list[int] = list(raw.get("ports") or [])[:500]
    services = []
    for item in (raw.get("data") or [])[:500]:
        services.append(
            {
                "port": item.get("port"),
                "transport": item.get("transport", "tcp"),
                "product": str(item.get("product") or "")[:200],
                "version": str(item.get("version") or "")[:100],
                "banner": _truncate(str(item.get("data") or "")),
            }
        )
    return {
        "ip": ip,
        "ports": ports,
        "services": services,
        "vulns": (
            list((raw.get("vulns") or {}).keys())[:500]
            if isinstance(raw.get("vulns"), dict)
            else []
        ),
        "isp": str(raw.get("isp") or "")[:200],
        "asn": str(raw.get("asn") or "")[:100],
        "city": str(raw.get("city") or "")[:100],
        "country": str(raw.get("country_name") or "")[:100],
    }
