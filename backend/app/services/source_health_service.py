"""Per-source reachability probes for `GET /health/sources`.

WHAT THIS IS
------------
A status endpoint that answers "can this deployment actually reach its
sources right now", behind the same TTL cache the scan path uses
(`app/core/cache.py`, AGENTS.md §7-§8). It is deliberately NOT a probe on
every scan: a scan must never pay for a status check, so the probes run only
when someone asks for the status, and the answer is then cached for
`SOURCE_HEALTH_TTL_SECONDS` so a refresh button cannot become an
outbound-request generator.

THE HONESTY RULE
----------------
A probe reports what it established, never what it assumes:

  * ``ok``       — the source answered the probe (HTTP 2xx, or a real WHOIS /
                   DNS answer).
  * ``degraded`` — the source answered but signalled a problem: HTTP 429,
                   5xx, or a rejected API key. Reachable, not usable.
  * ``unknown``  — nothing could be established: a timeout, a connection
                   failure, DNS failure, or a probe that never ran because the
                   source is not configured in this deployment.

``unknown`` is NOT "down". A timeout says as much about the network in between
as it does about the source, so there is no fourth status and no inference in
either direction — that is the whole reason the usual "Operational / Down"
pairing is not used here. A failed probe IS cached (with its timestamp): the
alternative is retrying a dead source on every request, which is exactly the
cost this endpoint exists to avoid.

WHAT EACH PROBE TOUCHES
-----------------------
Every probe is bounded by an explicit timeout, and each one names the single
cheapest endpoint that still proves the real path:

  * shodan — `GET /api/info` with the configured key. Without a key the probe
    does not run at all: ``not configured``, not a failure. api-info returns
    plan information and is not a host query, so a probe costs no scan credit.
  * crt.sh — the same query the scan path issues, for the reserved probe name.
  * whois  — a WHOIS lookup for the reserved probe name.
  * nvd    — a one-result CVE query.
  * dns    — one A-record lookup for the reserved probe name. This query is
    resolved by us and is visible to the probe name's authoritative
    nameservers, exactly like a scan's DNS source (see dns_service).

The probe target is `example.com` (RFC 2606): reserved for documentation, so
a health check adds no third party's load and reveals nothing about any user's
target.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any

import httpx

from app.core import cache as cache_mod
from app.core.config import settings
from app.services import dns_service, whois_service

CACHE_KEY = "health:sources"

#: The probe succeeded.
STATUS_OK = "ok"
#: The source answered but signalled a problem (429/5xx/rejected key).
STATUS_DEGRADED = "degraded"
#: Nothing could be established — timeout, connection failure, not configured.
STATUS_UNKNOWN = "unknown"

#: RFC 2606 reserved name. Never a real third party.
PROBE_DOMAIN = "example.com"

PROBE_NOTE = (
    "A status is a point-in-time probe, not an uptime guarantee. ok = the "
    "probe got an answer; degraded = the source answered but signalled a "
    "problem (429, 5xx, or a rejected key); unknown = nothing could be "
    "established (timeout, connection failure, or a probe that never ran "
    "because the source is not configured). unknown is not evidence that a "
    "source is down. The result is cached, so checked_at is when it was last "
    "probed, not now."
)


def _result(source: str, status: str, detail: str = "") -> dict[str, str]:
    return {"source": source, "status": status, "detail": detail[:300]}


def _http_result(source: str, status_code: int) -> dict[str, str]:
    """Map an HTTP status onto a probe result.

    A rejected key and a rate-limited source are both *answers*: the source is
    reachable and telling us something actionable, which is `degraded`, not
    `unknown`. Only a non-2xx that carries no such meaning collapses into
    `degraded` with the status recorded — never into a guess about health.
    """
    if 200 <= status_code < 300:
        return _result(source, STATUS_OK)
    if status_code in (401, 403):
        return _result(
            source,
            STATUS_DEGRADED,
            f"reachable but credentials rejected (HTTP {status_code})",
        )
    if status_code == 429:
        return _result(source, STATUS_DEGRADED, "reachable but rate-limited (HTTP 429)")
    if status_code >= 500:
        return _result(
            source, STATUS_DEGRADED, f"reachable but failing (HTTP {status_code})"
        )
    return _result(source, STATUS_DEGRADED, f"unexpected answer (HTTP {status_code})")


async def _probe_http(
    client: httpx.AsyncClient, source: str, url: str, params: dict[str, str]
) -> dict[str, str]:
    """One bounded GET. Every failure is `unknown` with the reason recorded."""
    try:
        response = await client.get(url, params=params)
    except (httpx.TimeoutException, httpx.HTTPError, OSError) as e:
        # httpx.TimeoutException covers ConnectTimeout/ReadTimeout; httpx.HTTPError
        # covers the rest of the transport family; OSError covers DNS failures
        # that surface before a request exists. All of them mean "nothing could
        # be established" and none of them mean "the source is down".
        return _result(source, STATUS_UNKNOWN, f"probe failed: {type(e).__name__}")
    return _http_result(source, response.status_code)


async def _probe_shodan(client: httpx.AsyncClient) -> dict[str, str]:
    key = (settings.shodan_api_key or "").strip()
    if not key:
        # Not configured is a supported state, not a failure: a blank key is a
        # deliberate budget decision (see config.py). Reporting it as anything
        # other than "the probe never ran" would fabricate a fault.
        return _result("shodan", STATUS_UNKNOWN, "not configured (no SHODAN_API_KEY)")
    return await _probe_http(
        client,
        "shodan",
        "https://api.shodan.io/api-info",
        {"key": key},
    )


async def _probe_crtsh(client: httpx.AsyncClient) -> dict[str, str]:
    return await _probe_http(
        client,
        "crtsh",
        "https://crt.sh/",
        {"q": f"%.{PROBE_DOMAIN}", "output": "json"},
    )


async def _probe_nvd(client: httpx.AsyncClient) -> dict[str, str]:
    return await _probe_http(
        client,
        "nvd",
        "https://services.nvd.nist.gov/rest/json/cves/2.0",
        {"resultsPerPage": "1"},
    )


async def _probe_whois() -> dict[str, str]:
    """WHOIS for the reserved probe name, bounded by the scan's own budget."""
    try:
        await asyncio.wait_for(
            whois_service.lookup(PROBE_DOMAIN), timeout=settings.scan_timeout_whois
        )
    except Exception as e:  # noqa: BLE001 — one probe failing never fails the status
        return _result("whois", STATUS_UNKNOWN, f"probe failed: {type(e).__name__}")
    return _result("whois", STATUS_OK)


async def _probe_dns() -> dict[str, str]:
    """One A-record lookup, bounded by the DNS source's own budget.

    A partial answer (some record types unanswered) is `degraded` — the
    resolver works but is not answering everything. An answer with no records
    at all for the reserved probe name is also `degraded`: a resolver that
    reports NXDOMAIN for example.com is not reporting truth.
    """
    try:
        result = await asyncio.wait_for(
            dns_service.lookup(PROBE_DOMAIN), timeout=settings.scan_timeout_dns
        )
    except Exception as e:  # noqa: BLE001 — see _probe_whois
        return _result("dns", STATUS_UNKNOWN, f"probe failed: {type(e).__name__}")
    records = result.get("records") or {}
    if any(records.values()):
        if result.get("errors"):
            return _result(
                "dns", STATUS_DEGRADED, "answered, but some record types failed"
            )
        return _result("dns", STATUS_OK)
    return _result(
        "dns",
        STATUS_DEGRADED,
        str(result.get("note") or "no records answered for the probe name")[:300],
    )


async def _probe_all() -> dict[str, dict[str, str]]:
    """Run every probe concurrently, bounded, sharing one client."""
    async with httpx.AsyncClient(
        timeout=settings.fetch_timeout_seconds,
        headers={"User-Agent": "osint-dashboard/1.0"},
    ) as client:
        settled = await asyncio.gather(
            _probe_shodan(client),
            _probe_crtsh(client),
            _probe_nvd(client),
            _probe_whois(),
            _probe_dns(),
            return_exceptions=True,
        )
    probes: dict[str, dict[str, str]] = {}
    for source, outcome in zip(("shodan", "crtsh", "nvd", "whois", "dns"), settled):
        if isinstance(outcome, BaseException):
            # A probe body that raises is a bug in this module, not a finding
            # about the source. It must not fabricate a status either way.
            probes[source] = _result(
                source, STATUS_UNKNOWN, f"probe crashed: {type(outcome).__name__}"
            )
            continue
        probes[source] = outcome
    return probes


async def source_status() -> dict[str, Any]:
    """Cached per-source status. A cache hit costs zero upstream requests.

    The cache write is not wrapped in its own try: `cache_set_async` already
    swallows every failure by design, so a dead cache degrades to "probe again
    next call" rather than to a 500.
    """
    cached = await cache_mod.cache_get_async(CACHE_KEY)
    if isinstance(cached, dict) and isinstance(cached.get("sources"), dict):
        return {
            "sources": cached["sources"],
            "checked_at": str(cached.get("checked_at") or ""),
            "note": PROBE_NOTE,
            "cached": True,
        }

    payload = {
        "sources": await _probe_all(),
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "note": PROBE_NOTE,
        "cached": False,
    }
    await cache_mod.cache_set_async(
        CACHE_KEY, payload, settings.source_health_ttl_seconds
    )
    return payload
