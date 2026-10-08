"""Per-capability analysis endpoints, each reachable on its own.

One endpoint per capability rather than one combined "analyse this target"
call, for the reason the TODO states: a module that fails must not take down the
others. Here that is structural — there is no shared fan-out to fail, so
contact extraction being down cannot cost you your DNS records.

Three cross-cutting rules this router owns:

  * Every endpoint calls `require_user()` (AGENTS.md §5.2) and a rate limit.
    Capabilities that draw no Shodan credit use `check_free_rate_limit`, NOT
    `check_rate_limit`, because that one is a billing decision about the shared
    paid key (see the docstring there for why aliasing them is a regression).
  * A policy or network failure is HTTP 200 with an entry in `errors[]`. Only a
    caller mistake (bad input) is 4xx. A blocked target must never look like a
    server error, and must never look like "no findings" either — the error text
    says what was refused.
  * Results are cached with the same TTL discipline as the scan path, and a
    `force=true` bypasses it. A pure cache hit costs no upstream request.
"""

from __future__ import annotations

import asyncio
import base64
import ipaddress
import re
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from typing import Annotated, Any
from urllib.parse import urlsplit, urlunsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException

from app.core import cache as cache_mod
from app.core.config import settings
from app.core.rate_limit import check_free_rate_limit
from app.core.security import assert_target_allowed, require_user
from app.core.ssrf import SafeFetcher, SsrfBlocked, SsrfError, SsrfTimeout
from app.schemas.analysis import (
    AnalysisResponse,
    DomainAnalysisRequest,
    UrlAnalysisRequest,
)
from app.services import (
    contact_service,
    dns_service,
    exif_service,
    http_headers_service,
    phone_lookup_service,
    redirect_service,
    sitemap_service,
    tls_service,
)
from app.services.exif_service import MAX_INPUT_BYTES

router = APIRouter(prefix="/api/v1/analysis", tags=["analysis"])

UserDep = Annotated[str, Depends(require_user)]

# How long a derived view of a target's live HTTP surface stays fresh. Shorter
# than the scan cache TTL (24h) on purpose: a redirect chain, a cookie attribute
# and a sitemap are all things a target changes, and a day-stale "this is where
# the site redirects" is worse than useless. The TLS cert view is the exception
# and gets its own longer key below.
LIVE_HTTP_CACHE_TTL = 900
TLS_CACHE_TTL = 24 * 3600


# A hostname is a dot-separated list of LDH labels. Deliberately mirrors the
# shape of app/schemas/scan.py::TARGET_RE so both endpoints agree on what a
# plausible target looks like; an IP literal is also a legitimate analysis
# target and is allowed through separately.
_HOSTNAME_RE = re.compile(r"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$")


def _normalize_url(raw: str) -> str:
    """Accept a bare domain, IP, or host:port and return a fetchable URL.

    Defaults to https, because a target that only serves http is a finding the
    TLS and redirect capabilities should report — not something the URL builder
    should silently paper over by choosing the insecure scheme for them.

    This checks the HOST's shape, not merely its presence. `urlsplit` is
    permissive: it reports a hostname of "not a url" (spaces) for one input, and
    "javascript" with a nonsense port for another, and both would otherwise sail
    through to the fetch layer. The SSRF guard remains the real security
    boundary; this exists so obvious garbage is a clear 400 rather than a
    confusing 200-with-errors.
    """
    candidate = raw.strip()
    if "://" not in candidate:
        candidate = f"https://{candidate}"

    try:
        parts = urlsplit(candidate)
        # Touching .port is what raises on a non-numeric port, which is what
        # rejects "https://javascript:alert(1)".
        port = parts.port
    except ValueError as e:
        raise HTTPException(status_code=400, detail="Malformed URL") from e

    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise HTTPException(
            status_code=400, detail="Provide an http(s) URL or a domain"
        )

    host = parts.hostname.lower()
    try:
        ipaddress.ip_address(host)
    except ValueError:
        if not _HOSTNAME_RE.match(host):
            raise HTTPException(status_code=400, detail="Not a valid hostname")

    # Rebuilt from the host rather than reusing parts.netloc, so userinfo can
    # never survive into the cache key or a log line: "https://a@evil/" is read
    # differently by different clients, and the SSRF guard refuses it anyway.
    netloc = host if port is None else f"{host}:{port}"
    # Reassembled rather than passed through, so "example.com" and
    # "https://example.com" produce one identical cache key.
    return urlunsplit((parts.scheme, netloc, parts.path or "/", parts.query, ""))


def _cache_key(capability: str, target: str) -> str:
    return f"analysis:{capability}:{target.lower()}"


async def _cached(
    capability: str,
    target: str,
    force: bool,
    ttl: int,
    produce: Callable[[], Awaitable[dict[str, Any]]],
) -> tuple[dict[str, Any] | None, list[dict[str, str]]]:
    """Cache-aware wrapper. Returns (cached_or_fresh_data, errors)."""
    key = _cache_key(capability, target)
    if not force:
        hit = await cache_mod.cache_get_async(key)
        if hit is not None:
            return hit, []
    try:
        data = await produce()
    except SsrfBlocked as e:
        # A refused target is a policy decision, and the user should read it as
        # one. Reporting it as "no findings" would be the dangerous lie here.
        return None, [{"source": capability, "message": str(e)[:500]}]
    except (SsrfTimeout, SsrfError) as e:
        return None, [{"source": capability, "message": str(e)[:500]}]
    except httpx.HTTPError as e:
        # Upstream is untrusted: a third-party failure is a partial result, not a
        # 500 (AGENTS.md §5.4), and the raw exception text never reaches here.
        return None, [
            {
                "source": capability,
                "message": f"{capability}: {type(e).__name__}"[:500],
            }
        ]
    await cache_mod.cache_set_async(key, data, ttl)
    return data, []


def _envelope(
    capability: str,
    target: str,
    data: dict[str, Any] | None,
    errors: list[dict[str, str]],
) -> dict[str, Any]:
    return {
        "capability": capability,
        "target": target,
        "source": (data or {}).get("source", ""),
        "status": "error" if (errors and data is None) else "ok",
        "data": data or {},
        "errors": errors,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    }


async def _run_fetching(
    capability: str,
    body: UrlAnalysisRequest,
    service: Any,
    user_id: str,
    scope: str,
) -> AnalysisResponse:
    """Shared path for every capability that fetches a target behind the guard.

    One SafeFetcher for the request, closed here, so a caller can never leak a
    client by forgetting it, and `follow_redirects`/`trust_env` are always the
    guard's values rather than the caller's.
    """
    url = _normalize_url(body.url)
    # The cheap string check runs against the HOST, not the whole URL:
    # is_blocked_target() inspects the string for an IP literal, and
    # "http://127.0.0.1/" is not one. Passing the URL here would make this a
    # no-op that silently validates nothing (AGENTS.md §5.3).
    assert_target_allowed(urlsplit(url).hostname or url)
    check_free_rate_limit(user_id, scope)
    async with SafeFetcher() as fetcher:
        data, errors = await _cached(
            capability,
            url,
            body.force,
            LIVE_HTTP_CACHE_TTL,
            lambda: service.lookup(url, fetcher),
        )
    return AnalysisResponse(**_envelope(capability, url, data, errors))


# --- capabilities that fetch the target (all behind the SSRF guard) ----------


@router.post("/headers")
async def post_headers(body: UrlAnalysisRequest, user_id: UserDep) -> AnalysisResponse:
    return await _run_fetching("headers", body, http_headers_service, user_id, "fetch")


@router.post("/redirects")
async def post_redirects(
    body: UrlAnalysisRequest, user_id: UserDep
) -> AnalysisResponse:
    return await _run_fetching("redirects", body, redirect_service, user_id, "fetch")


@router.post("/sitemap")
async def post_sitemap(body: UrlAnalysisRequest, user_id: UserDep) -> AnalysisResponse:
    return await _run_fetching("sitemap", body, sitemap_service, user_id, "fetch")


@router.post("/contacts")
async def post_contacts(body: UrlAnalysisRequest, user_id: UserDep) -> AnalysisResponse:
    # Its own `contact` scope: this is an address-harvesting primitive and must
    # not be able to exhaust a user's scan allowance.
    return await _run_fetching("contacts", body, contact_service, user_id, "contact")


# --- capabilities that query a data source ---------------------------------


@router.post("/dns")
async def post_dns(body: DomainAnalysisRequest, user_id: UserDep) -> AnalysisResponse:
    target = body.target.strip().lower().rstrip(".")
    assert_target_allowed(target)
    check_free_rate_limit(user_id, "dns")
    try:
        data, errors = await _cached(
            "dns",
            target,
            body.force,
            LIVE_HTTP_CACHE_TTL,
            lambda: dns_service.lookup(target),
        )
    except ValueError as e:
        # IP literals and malformed hostnames are caller mistakes, not outages.
        raise HTTPException(status_code=400, detail=str(e)[:300]) from e
    return AnalysisResponse(**_envelope("dns", target, data, errors))


@router.post("/tls")
async def post_tls(body: DomainAnalysisRequest, user_id: UserDep) -> AnalysisResponse:
    target = body.target.strip().lower().rstrip(".")
    assert_target_allowed(target)
    check_free_rate_limit(user_id, "tls")
    data, errors = await _cached(
        "tls",
        target,
        body.force,
        TLS_CACHE_TTL,
        lambda: tls_service.lookup(target),
    )
    return AnalysisResponse(**_envelope("tls", target, data, errors))


@router.post("/exif")
async def post_exif(body: dict[str, Any], user_id: UserDep) -> AnalysisResponse:
    """EXIF from an uploaded image.

    A raw dict rather than a typed model because the bytes arrive base64 in
    JSON and the HTTP-layer size cap is enforced by the caller; the service
    re-sniffs the actual content and never trusts a declared type.
    """
    check_free_rate_limit(user_id, "exif")
    encoded = body.get("data")
    if not isinstance(encoded, str):
        raise HTTPException(status_code=400, detail="`data` must be a base64 string")
    # Bound the decoded size before decoding: base64 inflates by ~4/3, so an
    # oversized upload must be rejected on the encoded length too, or the
    # service-level cap is only reached after the memory is already spent.
    if len(encoded) > (MAX_INPUT_BYTES // 3) * 4 + 4:
        raise HTTPException(status_code=413, detail="Image exceeds the size cap")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, TypeError) as e:
        raise HTTPException(status_code=400, detail="`data` is not valid base64") from e

    filename = body.get("filename")
    if filename is not None and not isinstance(filename, str):
        raise HTTPException(status_code=400, detail="`filename` must be a string")
    # Synchronous and CPU-bound on attacker-chosen bytes: keep it off the loop.
    result = await asyncio.to_thread(exif_service.extract, raw, filename=filename)
    if not result.get("ok"):
        # A rejected upload is a caller error with a stated reason, not a 500.
        raise HTTPException(
            status_code=400,
            detail=str(result.get("rejected_reason") or "Unsupported image")[:300],
        )
    # Render-only by default: GPS and serials are reported as present but
    # withheld unless the caller explicitly opted in (AGENTS.md §7).
    return AnalysisResponse(**_envelope("exif", filename or "upload", result, []))


@router.get("/phone/{number:path}")
async def get_phone(number: str, user_id: UserDep) -> AnalysisResponse:
    """Offline phone format/country validation on its own endpoint.

    A GET path segment rather than a POST body because the router must not reuse
    the domain-scan path for phone data at all (TODO: separate endpoint and
    separate rate-limit bucket, so the two can never share a quota).
    """
    check_free_rate_limit(user_id, "phone")
    try:
        result = phone_lookup_service.lookup(number)
    except (ValueError, TypeError) as e:
        raise HTTPException(status_code=422, detail=str(e)[:300]) from e
    return AnalysisResponse(**_envelope("phone", number[:64], result, []))


@router.get("/capabilities")
async def get_capabilities(user_id: UserDep) -> dict[str, Any]:
    """Which optional sources are live in this deployment.

    Exists because several sources ship dark by design (Leak-Lookup needs a
    key, VirusTotal and OTX degrade differently without one). A UI that renders
    an empty card should be able to say WHY it is empty instead of leaving the
    user to guess whether they found something or mis-configured something.
    """
    _ = user_id
    return {
        "always_available": [
            "headers",
            "redirects",
            "sitemap",
            "contacts",
            "dns",
            "tls",
            "exif",
            "phone",
        ],
        "optional_sources": {
            "leaklookup": bool((settings.leaklookup_api_key or "").strip()),
            "urlscan": True,
            "virustotal": bool((settings.virustotal_api_key or "").strip()),
            # OTX serves several endpoints anonymously at a lower rate limit, so
            # this is "usable", not "off" — the distinction matters for the UI's
            # empty-state wording.
            "otx": True,
        },
    }
