"""Shodan host lookup. Never called from browser; backend only."""

from __future__ import annotations

from typing import Any

import httpx

from app.core.config import settings
from app.core.security import assert_target_allowed, resolve_target_ip
from app.services.cpe_util import normalize_cpe

BASE = "https://api.shodan.io"
INTERNETDB_BASE = "https://internetdb.shodan.io"


def _truncate(s: str, n: int = 2048) -> str:
    return s[:n] if isinstance(s, str) else ""


def _clean_cpe(value: Any) -> str | None:
    # Only exact CPE names are trusted for NVD lookups.
    # Keyword/product matching is intentionally rejected (false-positive risk).
    # CPE 2.2 URIs (cpe:/a:vendor:...) are normalized to CPE 2.3.
    return normalize_cpe(value)


def _collect_cpes(values: Any, limit: int = 100) -> list[str]:
    collected: list[str] = []
    seen: set[str] = set()
    if isinstance(values, str):
        values = [values]
    if not isinstance(values, (list, tuple)):
        return []
    for item in values:
        # Shodan host `cpe` may be a list per service; flatten one level.
        candidates = item if isinstance(item, (list, tuple)) else [item]
        for candidate in candidates:
            cleaned = _clean_cpe(candidate)
            if cleaned and cleaned not in seen:
                seen.add(cleaned)
                collected.append(cleaned)
                if len(collected) >= limit:
                    return collected
    return collected


def _is_ip(target: str) -> bool:
    parts = target.split(".")
    return len(parts) == 4 and all(p.isdigit() for p in parts)


def _map_internetdb(raw: Any, ip: str) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise TypeError("Shodan InternetDB returned an invalid response")
    ports = [
        port
        for port in (raw.get("ports") or [])
        if isinstance(port, int) and not isinstance(port, bool) and 1 <= port <= 65535
    ][:500]
    vulns = [vuln[:100] for vuln in (raw.get("vulns") or []) if isinstance(vuln, str)][
        :500
    ]
    cpes = _collect_cpes(raw.get("cpes"))
    return {
        "source": "Shodan InternetDB",
        "ip": ip,
        "ports": ports,
        "services": [
            {
                "port": port,
                "transport": "tcp",
                "product": "",
                "version": "",
                "banner": "",
            }
            for port in ports
        ],
        "vulns": vulns,
        "cpes": cpes,
    }


async def _lookup_internetdb(ip: str, client: httpx.AsyncClient) -> dict[str, Any]:
    response = await client.get(
        f"{INTERNETDB_BASE}/{ip}",
        timeout=settings.scan_timeout_shodan,
    )
    if response.status_code == 404:
        return _map_internetdb({}, ip)
    response.raise_for_status()
    return _map_internetdb(response.json(), ip)


async def lookup(
    target: str,
    client: httpx.AsyncClient | None = None,
    *,
    resolved_ip: str | None = None,
) -> dict[str, Any]:
    """Look a target up on Shodan, with InternetDB as the free fallback.

    `resolved_ip` lets a caller that already resolved this target (the scan
    router's pre-flight, which must run to answer a blocked IP with a 400) hand
    that answer down instead of making us resolve the same name twice. It is
    keyword-only and optional: called without it, as every direct caller does,
    the hostname is resolved here exactly as before.
    """
    if not settings.shodan_api_key:
        raise RuntimeError("SHODAN_API_KEY not configured")
    ip = target if resolved_ip is None else resolved_ip
    if not _is_ip(ip):
        # Either a hostname, or a handed-down value that is not a usable IP: fall
        # back to resolving the target ourselves rather than trusting the input.
        ip = await resolve_target_ip(target)
    # The hostname string passed validation but the IP actually sent to
    # Shodan/InternetDB is what has to be allowed, whichever path produced it.
    # This is the guarantee that a blocked IP costs zero outbound requests, even
    # for a resolved_ip nobody here resolved or validated.
    assert_target_allowed(ip)
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
        if status in (403, 404):
            try:
                return await _lookup_internetdb(ip, client)
            except (httpx.HTTPError, TypeError, ValueError) as fallback_error:
                raise RuntimeError(
                    f"Shodan host lookup returned HTTP {status} and its public "
                    f"InternetDB fallback failed: {fallback_error}"
                ) from fallback_error
        if status == 401:
            raise RuntimeError("Shodan API key invalid (HTTP 401)") from e
        raise RuntimeError(f"Shodan lookup failed (HTTP {status})") from e
    finally:
        if own:
            await client.aclose()
    ports: list[int] = list(raw.get("ports") or [])[:500]
    services = []
    host_cpes: list[str] = []
    seen_cpes: set[str] = set()
    for item in (raw.get("data") or [])[:500]:
        service_cpes = _collect_cpes(item.get("cpe"))
        for cpe in service_cpes:
            if cpe not in seen_cpes:
                seen_cpes.add(cpe)
                host_cpes.append(cpe)
                if len(host_cpes) >= 100:
                    break
        services.append(
            {
                "port": item.get("port"),
                "transport": item.get("transport", "tcp"),
                "product": str(item.get("product") or "")[:200],
                "version": str(item.get("version") or "")[:100],
                "banner": _truncate(str(item.get("data") or "")),
                "cpes": service_cpes,
            }
        )
    return {
        "source": "Shodan",
        "ip": ip,
        "ports": ports,
        "services": services,
        "vulns": (
            list((raw.get("vulns") or {}).keys())[:500]
            if isinstance(raw.get("vulns"), dict)
            else []
        ),
        "cpes": host_cpes,
        "isp": str(raw.get("isp") or "")[:200],
        "asn": str(raw.get("asn") or "")[:100],
        "city": str(raw.get("city") or "")[:100],
        "country": str(raw.get("country_name") or "")[:100],
    }
