"""WHOIS via blocking python-whois offloaded to a thread."""

from __future__ import annotations

import asyncio
from typing import Any


def _sync_lookup(target: str) -> dict[str, Any]:
    import whois  # local import so tests can stub

    w = whois.whois(target)
    get = lambda k: (
        getattr(w, k, None)
        if hasattr(w, k)
        else (w.get(k) if isinstance(w, dict) else None)
    )
    fmt = lambda v: str(v)[:500] if v is not None else None
    ns = get("name_servers") or []
    if isinstance(ns, str):
        ns = [ns]
    return {
        "domain": target,
        "registrar": fmt(get("registrar")),
        "creation_date": fmt(get("creation_date")),
        "expiration_date": fmt(get("expiration_date")),
        "name_servers": [str(x)[:200] for x in (ns or [])][:20],
        "emails": fmt(get("emails")) or "redacted",
    }


async def lookup(target: str) -> dict[str, Any]:
    return await asyncio.to_thread(_sync_lookup, target)
