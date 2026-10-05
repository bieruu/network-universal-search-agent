"""Orchestrator: fan-out with per-source timeout, partial failure first-class."""

from __future__ import annotations

import asyncio
import re
import uuid
from datetime import datetime, timezone
from typing import Any

import httpx

from app.core import cache as cache_mod
from app.core.config import settings
from app.services import (
    certspotter_service,
    crtsh_service,
    nvd_service,
    risk,
    shodan_service,
    subfinder_service,
    whois_service,
)


async def _with_timeout(coro, seconds: int, source: str) -> Any:
    try:
        return await asyncio.wait_for(coro, timeout=seconds)
    except asyncio.TimeoutError as e:
        raise RuntimeError(
            f"{source}: timed out after {seconds}s — retry with Re-scan"
        ) from e
    except Exception as e:
        raise RuntimeError(sanitize_error(source, e)) from e


def sanitize_error(source: str, e: BaseException) -> str:
    """Build a user-safe error message. Never leaks query params (API keys)."""
    status = getattr(getattr(e, "response", None), "status_code", None)
    msg = str(e)[:500]
    # Strip anything that looks like an API key in a URL.
    msg = re.sub(r"([?&]key=)[^&\s]+", r"\1…", msg)
    msg = re.sub(r"key=\S+", "key=…", msg)
    # Service-curated messages are already user-safe; don't double-prefix them.
    if isinstance(e, RuntimeError) and msg.lower().startswith(
        ("shodan", "crt.sh", "subfinder")
    ):
        return msg[:500]
    if status is not None:
        return f"{source}: HTTP {status} — {msg}"[:500]
    if isinstance(e, (asyncio.TimeoutError, TimeoutError)):
        return f"{source}: timed out — retry with Re-scan"[:500]
    return f"{source}: {type(e).__name__}: {msg}"[:500]


async def _certificate_fallback(target: str, client: httpx.AsyncClient) -> Any:
    failures: list[str] = []
    for source, lookup, timeout in (
        ("Cert Spotter", lambda: certspotter_service.lookup(target, client), 18),
        (
            "Subfinder",
            lambda: subfinder_service.lookup(target),
            subfinder_service.TIMEOUT_SECONDS,
        ),
    ):
        try:
            return await _with_timeout(lookup(), timeout, source)
        except RuntimeError as error:
            failures.append(f"{source}: {error}")
    raise RuntimeError(
        "All passive certificate fallbacks failed: " + "; ".join(failures)
    )


async def gather_results(
    target: str, force: bool = False
) -> tuple[dict[str, Any], list[dict[str, str]]]:
    """Run sources concurrently; use passive fallbacks if crt.sh fails."""
    ttl = settings.cache_ttl_hours * 3600
    cached: dict[str, Any] = {}
    async with httpx.AsyncClient(
        timeout=30.0,
        headers={"User-Agent": "osint-dashboard/1.0"},
        limits=httpx.Limits(max_connections=20),
    ) as client:
        # Build coroutines (cache-aware)
        jobs = {}
        for source, fn, timeout in (
            (
                "shodan",
                lambda: shodan_service.lookup(target, client),
                settings.scan_timeout_shodan,
            ),
            (
                "crtsh",
                lambda: crtsh_service.lookup(target, client),
                settings.scan_timeout_crtsh,
            ),
            (
                "whois",
                lambda: whois_service.lookup(target),
                settings.scan_timeout_whois,
            ),
        ):
            key = f"{source}:{target.lower()}"
            if not force:
                hit = await cache_mod.cache_get_async(key)
                if hit is not None:
                    cached[source] = hit
                    continue
            jobs[source] = _with_timeout(fn(), timeout, source)

        settled = (
            await asyncio.gather(*jobs.values(), return_exceptions=True) if jobs else []
        )
        results: dict[str, Any] = dict(cached)
        errors: list[dict[str, str]] = []
        for source, res in zip(jobs.keys(), settled):
            if isinstance(res, BaseException):
                if source == "crtsh":
                    try:
                        fallback = await _certificate_fallback(target, client)
                    except RuntimeError as fallback_error:
                        errors.append(
                            {
                                "source": source,
                                "message": f"{res}; {fallback_error}"[:500],
                            }
                        )
                    else:
                        results[source] = fallback
                        await cache_mod.cache_set_async(
                            f"{source}:{target.lower()}", fallback, ttl
                        )
                else:
                    errors.append({"source": source, "message": str(res)[:500]})
            else:
                results[source] = res
                await cache_mod.cache_set_async(f"{source}:{target.lower()}", res, ttl)
        # NVD enrichment runs after Shodan: exact CPEs only, never keywords.
        # NVD failure stays partial (results["nvd"].status=unavailable), never 500.
        # Skip when Shodan itself came from cache without CPE evidence to check:
        # enrichment must never trigger network on a pure cache hit.
        shodan = results.get("shodan")
        has_cpes = (
            isinstance(shodan, dict)
            and isinstance(shodan.get("cpes"), list)
            and bool(shodan.get("cpes"))
        )
        if has_cpes:
            assert isinstance(shodan, dict)
            try:
                nvd = await nvd_service.enrich_cpes(shodan.get("cpes"), client)
            except Exception as e:  # noqa: BLE001 — enrichment must never fail a scan
                nvd = {
                    "source": "NVD",
                    "status": "unavailable",
                    "checked_cpes": [],
                    "cves": [],
                    "truncated": False,
                    "errors": [f"NVD enrichment crashed: {type(e).__name__}"[:300]],
                    "note": "NVD enrichment failed unexpectedly; counts are partial evidence, not zero.",
                }
            results["nvd"] = nvd
            if nvd.get("status") == "unavailable":
                for msg in nvd.get("errors") or []:
                    errors.append({"source": "nvd", "message": str(msg)[:500]})
        elif isinstance(shodan, dict) and shodan.get("vulns"):
            # No CPE evidence to exact-match, but Shodan still reported CVE IDs:
            # keep them visible with an honest coverage status.
            results["nvd"] = {
                "source": "NVD",
                "status": "insufficient_evidence",
                "checked_cpes": [],
                "cves": [],
                "truncated": False,
                "errors": [],
                "note": "No CPE identifiers observed, so NVD CPE matching did not run; Shodan IDs are cross-checked by ID only.",
            }
        # CVE validity tiers (verified / unverified / rejected). NVD total
        # failure degrades every Shodan ID to `unverified`, never hidden.
        shodan = results.get("shodan")
        nvd = results.get("nvd")
        if isinstance(shodan, dict) and isinstance(nvd, dict):
            try:
                nvd["cve_rows"] = await nvd_service.build_cve_rows(
                    shodan.get("vulns"), nvd, client
                )
            except Exception as e:  # noqa: BLE001 — tiers must never fail a scan
                shodan_vulns = shodan.get("vulns") or []
                nvd["cve_rows"] = [
                    {
                        "id": str(v)[:30],
                        "tier": "unverified",
                        "source": "Shodan",
                        "severity": None,
                        "cvss": None,
                        "evidence_cpe": None,
                        "vuln_status": None,
                        "description": None,
                        "url": f"https://nvd.nist.gov/vuln/detail/{v}"[:120],
                    }
                    for v in shodan_vulns
                    if isinstance(v, str) and v.startswith("CVE-")
                ][:100]
                errors.append(
                    {
                        "source": "nvd",
                        "message": f"CVE tiering failed: {type(e).__name__}"[:500],
                    }
                )
        return results, errors


async def run_scan(
    target: str, user_id: str, force: bool = False, persist=None
) -> dict[str, Any]:
    """Full scan: gather, score, optionally persist via callback. Returns API payload."""
    scan_id = str(uuid.uuid4())
    results, errors = await gather_results(target, force=force)
    risk_score, breakdown = risk.score(results)
    ok = len(results)
    status = "completed" if not errors else ("partial" if ok else "failed")
    payload = {
        "scan_id": scan_id,
        "target": target,
        "status": status,
        "risk_score": risk_score,
        "results": {**results, "_risk_breakdown": breakdown},
        "errors": errors,
        "completed_at": datetime.now(timezone.utc).isoformat(),
    }
    if persist is not None:
        await persist(scan_id=scan_id, target=target, user_id=user_id, payload=payload)
    return payload
