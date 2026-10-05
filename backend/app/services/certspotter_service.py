"""Certificate Transparency fallback using the Cert Spotter API."""

from __future__ import annotations

import re
from typing import Any

import httpx

_API_URL = "https://api.certspotter.com/v1/issuances"
_TIMEOUT_SECONDS = 18.0
_MAX_ISSUANCES = 500
_MAX_SUBDOMAINS = 500
_LABEL_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")


def _normalize_name(value: Any, domain: str) -> str | None:
    if not isinstance(value, str):
        return None
    name = value.strip().lower().removeprefix("*.").rstrip(".")
    labels = name.split(".")
    if (
        not name
        or len(name) > 253
        or any(not _LABEL_RE.fullmatch(label) for label in labels)
        or (name != domain and not name.endswith(f".{domain}"))
    ):
        return None
    return name


async def lookup(
    target: str, client: httpx.AsyncClient | None = None
) -> dict[str, Any]:
    """Return bounded, in-scope names from public certificate records."""
    domain = target.strip().lower().removeprefix("*.").rstrip(".")
    own = client is None
    if own:
        client = httpx.AsyncClient(
            headers={"User-Agent": "osint-dashboard/1.0"},
        )

    try:
        response = await client.get(
            _API_URL,
            params={
                "domain": domain,
                "include_subdomains": "true",
                "match_wildcards": "true",
                "expand": "dns_names",
            },
            timeout=_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        raw = response.json()
    finally:
        if own and client is not None:
            await client.aclose()

    if not isinstance(raw, list):
        raise TypeError("Cert Spotter returned an invalid response")

    seen: dict[str, dict[str, str]] = {}
    for issuance in raw[:_MAX_ISSUANCES]:
        if not isinstance(issuance, dict):
            continue
        names = issuance.get("dns_names")
        if not isinstance(names, list):
            continue
        for value in names:
            name = _normalize_name(value, domain)
            if name and name not in seen:
                seen[name] = {
                    "subdomain": name,
                    "issuer": "",
                    "not_before": str(issuance.get("not_before") or "")[:40],
                    "not_after": str(issuance.get("not_after") or "")[:40],
                }
            if len(seen) >= _MAX_SUBDOMAINS:
                break
        if len(seen) >= _MAX_SUBDOMAINS:
            break

    return {
        "domain": domain,
        "source": "Cert Spotter",
        "count": len(seen),
        "subdomains": list(seen.values()),
    }
