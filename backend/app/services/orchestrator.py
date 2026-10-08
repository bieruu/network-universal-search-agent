"""Orchestrator: fan-out with per-source timeout, partial failure first-class."""

from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone
from typing import Any

import httpx

from app.core import cache as cache_mod
from app.core.config import settings
from app.core.errors import sanitize_error
from app.services import (
    certspotter_service,
    crtsh_service,
    host_enrichment_service,
    leaklookup_service,
    nvd_service,
    otx_service,
    risk,
    shodan_service,
    subfinder_service,
    urlscan_service,
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


async def _threat_history_fallback(
    target: str, client: httpx.AsyncClient, reason: str
) -> dict[str, Any]:
    """Run the breach/defacement sources when official CVE data came back empty.

    WHY THIS EXISTS: when NVD returns nothing for a target, the vulnerability
    tab is blank, and a blank tab reads as "this host is clean" — the exact
    opposite of what "we found no official CVEs" means. The history sources give
    the dashboard something honest to show instead.

    Reuses the `_certificate_fallback` shape deliberately (sequential, per-source
    timeout, aggregated error) rather than adding a parallel mechanism, so the
    orchestrator keeps exactly one way of running a fallback chain.

    Two rules this function exists to enforce:

      1. Each source is independent. One being down, unconfigured, or empty must
         not suppress the others, so a per-source failure is recorded and the
         chain continues.
      2. The response must STATE WHY it ran. `trigger_reason` travels with the
         payload, so a UI can say "no official CVEs; showing breach history
         instead" instead of silently substituting a different kind of evidence
         for the one the user asked about.

    Caching is the CALLER's job (see gather_results), which keeps this function
    a pure "run the chain" and leaves the force=true / cache-hit decision in one
    place.
    """
    sources = (
        # OTX first: it needs no key, so it is the one block that reliably comes
        # back with real detail (pulse names, descriptions, dates, malware
        # families). Leak-Lookup is kept behind it because a free key returns
        # breach NAMES ONLY with every column stripped.
        ("otx", otx_service, settings.scan_timeout_otx),
        ("urlscan", urlscan_service, settings.scan_timeout_urlscan),
        ("leaklookup", leaklookup_service, settings.scan_timeout_leaklookup),
    )

    blocks: dict[str, Any] = {}
    errors: list[dict[str, str]] = []
    for name, service, timeout in sources:
        try:
            blocks[name] = await _with_timeout(
                service.lookup(target, client), timeout, name
            )
        except Exception as e:  # noqa: BLE001 — one dead source must not stop the rest
            errors.append({"source": name, "message": sanitize_error(name, e)[:500]})

    # Cache-aware like every other job in this orchestrator: never spend an
    # upstream request on a pure cache hit unless force=true. These sources are
    # rate-limited and some of them cost money, so this is the difference
    # between a cheap re-render and a billed one.
    payload = {
        "source": "Threat & incident history",
        "triggered": True,
        "trigger_reason": reason,
        "note": (
            "No official CVE data was available for this target, so threat "
            "intelligence history is shown instead. Absence of CVEs is not evidence "
            "of safety, and these sources do not cover the same ground."
        ),
        "blocks": blocks,
        "errors": errors,
    }
    # Cache-aware like every other job in this orchestrator: never spend an
    # upstream request on a pure cache hit unless force=true. Some of these
    # sources are rate-limited or paid, so this is the difference between a
    # cheap re-render and a billed one.
    await cache_mod.cache_set_async(
        f"history:{target.lower()}", payload, settings.cache_ttl_hours * 3600
    )
    return payload


def _keyword_inputs(shodan: dict[str, Any], nvd: Any) -> list[str]:
    """Product strings to derive keyword-search terms from, best source first.

    Three sources, in descending confidence:

      1. `services[].product` — the strongest signal, but Shodan frequently
         leaves it empty even when it identified the product via CPE.
      2. **The CPE vendor/product** (`cpe:2.3:a:cloudflare:cloudflare:...`).
         This is the one that actually rescues the common case: Shodan returns a
         CPE for a target whose service banners carry no product string, so a
         fallback keyed only on `product` finds nothing and the card stays at 0.
         We already queried this CPE, so the vendor/product pair is the highest
         quality term available.
      3. Hostnames — weakest, and often just the domain itself.

    Banners are deliberately excluded: `derive_keywords` splits on word
    boundaries anyway, so a raw banner only contributes noise ahead of the real
    product under a 3-term cap.
    """
    out: list[str] = []
    seen: set[str] = set()

    def _add(value: Any) -> None:
        if (
            isinstance(value, str)
            and value.strip()
            and value.strip().lower() not in seen
        ):
            seen.add(value.strip().lower())
            out.append(value.strip())

    for service in shodan.get("services") or []:
        if isinstance(service, dict):
            _add(service.get("product"))

    # CPE vendor + product, from the CPEs NVD was already queried with.
    for cpe in (nvd.get("checked_cpes") if isinstance(nvd, dict) else None) or []:
        if not isinstance(cpe, str) or not cpe.startswith("cpe:2.3:"):
            continue
        parts = cpe.split(":")
        # cpe:2.3:part:vendor:product:version:...
        if len(parts) > 4:
            _add(parts[3])
            _add(parts[4])

    hostnames = shodan.get("hostnames")
    if isinstance(hostnames, list):
        for host in hostnames:
            _add(host)
    return out


def _cpe_evidence_found(nvd: Any) -> bool:
    """True when the exact-CPE path produced usable CVE evidence.

    Replacing a `found` result with keyword leads would downgrade real
    exact-match evidence, so this must be false for `found` regardless.
    """
    return bool(
        isinstance(nvd, dict) and nvd.get("status") == "found" and nvd.get("cves")
    )


def _keyword_fallback_allowed(nvd: Any) -> bool:
    """True when keyword leads would fill a real gap rather than hide a fault.

    `unavailable` is excluded, and this is a correctness rule rather than a
    nicety:

      - It means NVD could not be reached at all. The `unavailable` status and
        its `errors[]` entry are the honest signal; overwriting them with
        keyword leads would dress an infrastructure outage up as a result and
        lose the reason the card is thin.
      - The keyword fallback queries **the same NVD host**. If the CPE path could
        not reach it, the keyword path cannot either, so it could only ever add
        a second, redundant failure.

    A missing block still passes: nothing ran yet, which is the empty-card case
    the fallback exists for.
    """
    if not isinstance(nvd, dict):
        return True
    return nvd.get("status") != "unavailable"


def _history_trigger(results: dict[str, Any]) -> str | None:
    """Return why the history fallback should run, or None if it should not.

    Two triggers, matching the TODO:
      - NVD reported `insufficient_evidence` (it ran but had no CPE identifiers
        to match on), or
      - there are zero CVE rows to show.

    Anything else means the vulnerability tab has real content and the history
    block must NOT run — substituting breach history for a populated CVE list
    would hide the data the user actually asked for.

    There is also a precondition: at least one PRIMARY source must have
    succeeded. When Shodan, crt.sh and WHOIS all failed we learned nothing about
    the target, so "no CVE data" means "we could not check", not "there is
    none". Running history on top of that would dress a total outage up as a
    result — and the scan's own `status` would still be `failed`, which is the
    honest answer.
    """
    if not any(
        isinstance(results.get(source), dict) for source in ("shodan", "crtsh", "whois")
    ):
        return None

    nvd = results.get("nvd")
    cve_rows: list[Any] = []
    if isinstance(nvd, dict) and isinstance(nvd.get("cve_rows"), list):
        cve_rows = nvd["cve_rows"]

    if isinstance(nvd, dict) and nvd.get("status") == "insufficient_evidence":
        return "NVD reported insufficient evidence (no CPE identifiers to match on)"
    # Keyword leads are NOT host evidence: NVD matched a term inside a CVE
    # description, which says nothing about this target. So the vulnerability
    # card is still, in the sense that matters here, empty of usable evidence —
    # and history is exactly what fills it.
    if isinstance(nvd, dict) and nvd.get("status") == "keyword_derived":
        return (
            "NVD returned keyword-derived leads only (no CPE match for this "
            "target), so threat intelligence history is shown alongside them"
        )
    if not cve_rows:
        # Distinguish "we checked and found nothing" from "we never got to
        # check", because those lead to very different conclusions.
        shodan = results.get("shodan")
        if isinstance(shodan, dict) and shodan.get("vulns"):
            return "Shodan reported CVE IDs but none could be verified against NVD"
        return "No CVE data was available for this target"
    return None


async def _shodan_lookup(
    target: str, client: httpx.AsyncClient, resolved_ip: str | None
) -> dict[str, Any]:
    """Shodan job body, carrying the router's pre-flight answer if there is one.

    The pre-flight in the scan router already resolved this target — it has to,
    to reject a name pointing at a blocked IP with a 400 instead of a silent
    partial — so its IP is threaded down rather than resolved a second time.
    Forwarded only when present: with nothing pre-resolved the service resolves
    for itself, which is what every caller that skips the router gets.
    """
    if resolved_ip is None:
        return await shodan_service.lookup(target, client)
    return await shodan_service.lookup(target, client, resolved_ip=resolved_ip)


async def gather_results(
    target: str, force: bool = False, *, resolved_ip: str | None = None
) -> tuple[dict[str, Any], list[dict[str, str]]]:
    """Run sources concurrently; use passive fallbacks if crt.sh fails.

    `resolved_ip` is the caller's already-validated answer for this target (see
    _shodan_lookup). It is only consulted by the Shodan job, and that job is
    never built on a cache hit, so a cached Shodan still costs zero DNS queries
    and zero requests here.
    """
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
                lambda: _shodan_lookup(target, client, resolved_ip),
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

        # Keyword fallback: ONLY when the CPE path produced no usable result.
        # Replacing a `found` result with keyword leads would downgrade real
        # exact-match evidence, so it is strictly a gap-filler. The outcome
        # carries `status: "keyword_derived"`, which build_cve_rows and
        # risk.score both refuse to treat as host-specific evidence.
        if (
            isinstance(shodan, dict)
            and not _cpe_evidence_found(nvd)
            and _keyword_fallback_allowed(nvd)
        ):
            # derive_keywords takes a flat list of STRINGS and never descends
            # into dicts, so the product has to be pulled out here. Passing the
            # service dicts directly yields [] for every real Shodan payload,
            # which silently disables the whole fallback.
            terms = nvd_service.derive_keywords(_keyword_inputs(shodan, nvd))
            if terms:
                previous_note = nvd.get("note") if isinstance(nvd, dict) else None
                try:
                    results["nvd"] = await nvd_service.search_keywords(terms, client)
                except Exception as e:  # noqa: BLE001 — leads must never fail a scan
                    results["nvd"] = {
                        "source": "NVD",
                        "status": "unavailable",
                        "method": "keyword_search",
                        "keywords": terms,
                        "checked_cpes": [],
                        "cves": [],
                        "truncated": False,
                        "errors": [
                            f"NVD keyword search crashed: {type(e).__name__}"[:300]
                        ],
                        "note": previous_note
                        or "NVD keyword search failed unexpectedly.",
                    }
                nvd = results["nvd"]

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

        # Passive host enrichment (IP/ASN/geo/ports). Pure derivation over the
        # Shodan payload: no network, no second paid key, and therefore free to
        # compute on a cache hit — which is why it sits here rather than in the
        # job fan-out above, where building it would cost a Shodan request.
        if isinstance(results.get("shodan"), dict):
            results["host"] = host_enrichment_service.enrich(results["shodan"])

        # Breach/defacement history, ONLY when the vulnerability tab would
        # otherwise be empty. A populated CVE list must never be replaced by
        # incident history (see _history_trigger).
        if not force:
            cached_history = await cache_mod.cache_get_async(
                f"history:{target.lower()}"
            )
        else:
            cached_history = None
        if cached_history is not None:
            results["history"] = cached_history
        elif force or jobs:
            # Only run the chain when this call actually did work. On a pure
            # cache hit every primary source came from the cache, and spawning
            # four upstream requests here would break the rule the whole
            # orchestrator is built on: a cache hit costs zero network. The
            # history block then appears on the next cache-miss scan, or on an
            # explicit `force=true`.
            reason = _history_trigger(results)
            if reason:
                try:
                    history = await _threat_history_fallback(target, client, reason)
                    results["history"] = history
                except Exception as e:  # noqa: BLE001 — history must never fail a scan
                    errors.append(
                        {
                            "source": "history",
                            "message": f"Threat history failed: {type(e).__name__}"[
                                :500
                            ],
                        }
                    )
        return results, errors


async def run_scan(
    target: str,
    user_id: str,
    force: bool = False,
    persist=None,
    *,
    resolved_ip: str | None = None,
) -> dict[str, Any]:
    """Full scan: gather, score, optionally persist via callback. Returns API payload."""
    scan_id = str(uuid.uuid4())
    results, errors = await gather_results(target, force=force, resolved_ip=resolved_ip)
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
