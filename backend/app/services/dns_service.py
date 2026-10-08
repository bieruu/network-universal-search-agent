"""DNS record lookups (A, AAAA, MX, NS, TXT, CNAME, SOA) for a single domain.

Partial failure is the normal case here, not the exception: a name has seven
independent record types and any one of them can time out, SERVFAIL or simply
be absent while the other six answer cleanly. So every type is queried inside
its own try, and a failure lands in `errors[]` instead of discarding the
answers already collected — the same "partial failure is first-class" rule the
orchestrator applies across sources (AGENTS.md §5.4). Only two things are
fatal: an unusable target (ValueError, which the router turns into a 400) and
a bug in this module, which is deliberately allowed to surface rather than be
dressed up as a partial result.

Deliberately not implemented, per the v2 scope in TODO.md: AXFR zone transfer,
PTR/reverse lookups, DNSSEC validation, ANY queries and subdomain
enumeration. AXFR and DNSSEC are privilege an OSINT dashboard never needs, ANY
is an amplification primitive, and enumeration is unbounded by definition.
Caching lives with the router/orchestrator, which own cache policy.

Everything coming back is untrusted (AGENTS.md §5.4): the authoritative server
is chosen by whoever owns the target, so it decides the bytes. Values are cut
to MAX_VALUE_CHARS, TXT is cut much harder because SPF/DKIM/DMARC blobs run to
kilobytes, record counts are capped per type, and DNSException text — which a
hostile server can shape — is cut as well.

The resolver is asyncio-native (`dns.asyncresolver`), so awaiting it never
blocks the event loop. The blocking `dns.resolver.Resolver` must never appear
in this module (AGENTS.md §3); `test_dns_service.py` enforces that.
"""

from __future__ import annotations

import asyncio
import ipaddress
import re
from collections.abc import Callable, Iterator
from typing import Any, NamedTuple

import dns.asyncresolver
from dns.exception import DNSException
from dns.resolver import NXDOMAIN, NoAnswer

from app.core.config import settings

RECORD_TYPES: tuple[str, ...] = ("A", "AAAA", "MX", "NS", "TXT", "CNAME", "SOA")

MAX_RECORDS_PER_TYPE = 50
MAX_VALUE_CHARS = 2048
MAX_TXT_CHARS = 512
MAX_ERROR_CHARS = 300
MAX_DOMAIN_CHARS = 253

# Parsers stop one record past the cap. The overage is the only evidence that a
# type held more records than we keep, and stopping there means an rrset
# carrying thousands of entries is never walked in full.
_OVERSCAN = MAX_RECORDS_PER_TYPE + 1

# Mirrors certspotter_service._LABEL_RE and schemas.scan.TARGET_RE.
_LABEL_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")


def _timeout_seconds() -> float:
    """Per-query DNS budget in seconds.

    Read from settings so the bound is this repo's decision and stays
    configurable, matching the per-source timeouts the orchestrator applies to
    every other source (AGENTS.md §5.5). `scan_timeout_dns` is the intended
    knob; until that field is added to Settings the whois budget is reused,
    because DNS and WHOIS are the same shape of work — one bounded round trip
    to an external service that can be slow — and neither needs crt.sh's 30s.
    """
    return float(getattr(settings, "scan_timeout_dns", settings.scan_timeout_whois))


def _build_resolver(seconds: float) -> dns.asyncresolver.Resolver:
    """A resolver from system config with an explicit, bounded lifetime.

    `lifetime` is the whole-query budget (retries included) and `timeout` the
    per-attempt one; dnspython derives its attempt count from the pair. Both
    are set explicitly rather than left at dnspython's 5s/2s defaults so the
    bound is a decision made here and can be seen in the code.
    """
    resolver = dns.asyncresolver.Resolver()
    resolver.lifetime = seconds
    resolver.timeout = seconds
    return resolver


def _normalize_domain(target: str) -> str:
    """Lowercase, de-dot and validate a bare domain, rejecting IP literals.

    A wildcard prefix is stripped to match subfinder_service's target handling:
    `*.example.com` is how a certificate names a host, not something the
    resolver can answer for.

    An IP literal raises ValueError. DNS records are meaningless for an address
    — there is no name to look up — and returning an empty-but-successful
    result would be worse than failing: a caller would read "this host
    publishes no MX records" when the truth is "an MX lookup does not apply".
    """
    domain = target.strip().lower().rstrip(".").removeprefix("*.")
    try:
        ipaddress.ip_address(domain)
    except ValueError:
        pass
    else:
        raise ValueError("DNS lookup requires a hostname, not an IP address")

    labels = domain.split(".")
    if (
        not domain
        or len(domain) > MAX_DOMAIN_CHARS
        or len(labels) < 2
        or any(not _LABEL_RE.fullmatch(label) for label in labels)
    ):
        raise ValueError("DNS lookup requires a valid DNS domain")
    return domain


def _as_int(value: Any) -> int:
    """Coerce a TTL or SOA field to int; a malformed one reads as 0."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _clean(value: Any) -> str:
    """Cut an untrusted resolver string to a bounded length."""
    return str(value)[:MAX_VALUE_CHARS]


def _iter_rdata(answer: Any) -> Iterator[tuple[Any, int]]:
    """Yield ``(rdata, ttl)`` pairs out of a resolver answer.

    dnspython's answer iterates rrsets, and an rrset carries the TTL and
    iterates its own rdata; an injected resolver may instead hand back rdata
    directly. Both shapes are accepted — an entry that exposes `.rdtype` *and*
    is iterable is an rrset and gets descended into, anything else is the rdata
    itself. No dnspython container class is imported or isinstance-checked
    here, so a library upgrade cannot break the parse.
    """
    for entry in answer:
        if hasattr(entry, "rdtype") and hasattr(entry, "__iter__"):
            ttl = _as_int(getattr(entry, "ttl", 0))
            for rdata in entry:
                yield rdata, ttl
        else:
            yield entry, _as_int(getattr(entry, "ttl", 0))


def _parse_simple(answer: Any) -> list[dict[str, Any]]:
    """A / AAAA / NS / CNAME: one opaque value plus the rrset TTL."""
    rows: list[dict[str, Any]] = []
    for rdata, ttl in _iter_rdata(answer):
        rows.append({"value": _clean(rdata), "ttl": ttl})
        if len(rows) >= _OVERSCAN:
            break
    return rows


def _parse_mx(answer: Any) -> list[dict[str, Any]]:
    """MX: the mail exchanger, with its preference captured separately.

    `value` is the exchanger alone, not `str(rdata)` — that would repeat the
    preference inside the value. Rows are ordered by preference (RFC 5321
    delivery order) so the UI does not have to re-sort, using a stable sort so
    ties keep the resolver's order.
    """
    rows: list[dict[str, Any]] = []
    for rdata, ttl in _iter_rdata(answer):
        exchange = getattr(rdata, "exchange", None)
        rows.append(
            {
                "value": _clean(rdata if exchange is None else exchange),
                "preference": _as_int(getattr(rdata, "preference", 0)),
                "ttl": ttl,
            }
        )
        if len(rows) >= _OVERSCAN:
            break
    rows.sort(key=lambda row: row["preference"])
    return rows


def _parse_txt(answer: Any) -> list[dict[str, Any]]:
    """TXT, cut hard.

    SPF, DKIM and DMARC records are routinely several KB, and a scan response
    has to stay a summary rather than become a mail-policy archive. Each value
    is cut to MAX_TXT_CHARS (which is stricter than, and therefore also
    satisfies, the MAX_VALUE_CHARS bound on every other value) and says so in
    its own `truncated` flag rather than leaving a half-record to be mistaken
    for the whole thing.
    """
    rows: list[dict[str, Any]] = []
    for rdata, ttl in _iter_rdata(answer):
        text = str(rdata)
        rows.append(
            {
                "value": text[:MAX_TXT_CHARS],
                "ttl": ttl,
                "truncated": len(text) > MAX_TXT_CHARS,
            }
        )
        if len(rows) >= _OVERSCAN:
            break
    return rows


def _parse_soa(answer: Any) -> list[dict[str, Any]]:
    """SOA: every field, so the zone's serial and timers are readable."""
    rows: list[dict[str, Any]] = []
    for rdata, ttl in _iter_rdata(answer):
        rows.append(
            {
                "mname": _clean(getattr(rdata, "mname", "")),
                "rname": _clean(getattr(rdata, "rname", "")),
                "serial": _as_int(getattr(rdata, "serial", 0)),
                "refresh": _as_int(getattr(rdata, "refresh", 0)),
                "retry": _as_int(getattr(rdata, "retry", 0)),
                "expire": _as_int(getattr(rdata, "expire", 0)),
                "minimum": _as_int(getattr(rdata, "minimum", 0)),
                "ttl": ttl,
            }
        )
        if len(rows) >= _OVERSCAN:
            break
    return rows


_PARSERS: dict[str, Callable[[Any], list[dict[str, Any]]]] = {
    "A": _parse_simple,
    "AAAA": _parse_simple,
    "NS": _parse_simple,
    "CNAME": _parse_simple,
    "MX": _parse_mx,
    "TXT": _parse_txt,
    "SOA": _parse_soa,
}


class _Outcome(NamedTuple):
    """What one record-type query produced. DNS failure is a status, not a raise."""

    rdtype: str
    rows: list[dict[str, Any]]
    status: str
    message: str


async def _fetch(resolver: Any, domain: str, rdtype: str) -> _Outcome:
    """Run one record-type query, isolating its failure from the other six.

    NXDOMAIN and NoAnswer are subclasses of DNSException, so they are matched
    before it: they are answers, not failures. NXDOMAIN means the name does not
    exist; NoAnswer means the name exists and this type is simply unset — the
    note has to be able to tell those apart.
    """
    try:
        answer = await resolver.resolve(domain, rdtype)
    except NXDOMAIN:
        return _Outcome(rdtype, [], "nxdomain", "")
    except NoAnswer:
        return _Outcome(rdtype, [], "empty", "")
    except DNSException as exc:
        return _Outcome(rdtype, [], "error", str(exc)[:MAX_ERROR_CHARS])
    # Parsing sits outside the try on purpose: a failure here is a bug in this
    # module, not a hostile server, and must not be reported as a DNS problem.
    return _Outcome(rdtype, _PARSERS[rdtype](answer), "ok", "")


def _join(values: list[str]) -> str:
    return ", ".join(values)


def _build_note(
    domain: str,
    nxdomain: list[str],
    empty: list[str],
    errored: list[str],
    cut_types: list[str],
    counts_truncated: bool,
    has_records: bool,
) -> str:
    """One line stating what about this answer is not complete.

    NXDOMAIN and an empty answer both end up in `missing`, but they mean
    opposite things — the name does not exist, versus the name exists and this
    type is unset — so the note always says which is which instead of leaving a
    reader to infer it. Empty string when nothing was lost or cut.
    """
    parts: list[str] = []
    if nxdomain:
        if len(nxdomain) == len(RECORD_TYPES) and not has_records:
            parts.append(
                f"{domain} does not resolve: NXDOMAIN on every queried record type."
            )
        else:
            parts.append(f"NXDOMAIN (the name does not exist) on {_join(nxdomain)}.")
    if empty:
        parts.append(
            f"No records published for {_join(empty)} (NOERROR, empty answer)."
        )
    if errored:
        parts.append(
            f"{_join(errored)} could not be queried; counts are partial evidence, "
            "not zero."
        )
    if cut_types:
        parts.append(f"{_join(cut_types)} values cut to {MAX_TXT_CHARS} characters.")
    if counts_truncated:
        parts.append(f"Record counts capped at {MAX_RECORDS_PER_TYPE} per type.")
    return "; ".join(parts)


async def lookup(
    target: str, resolver: dns.asyncresolver.Resolver | None = None
) -> dict[str, Any]:
    """Resolve seven record types for `target`, isolating per-type failure.

    `resolver` is the test seam: when given it is used verbatim, and its own
    timeout configuration is left alone because this module does not mutate an
    object it does not own. When None, a resolver is built from system config
    with an explicit bounded lifetime.

    Raises ValueError for an IP literal or a malformed hostname (the router
    turns that into a 400). Every other DNS condition is partial, never fatal.
    """
    domain = _normalize_domain(target)
    if resolver is None:
        resolver = _build_resolver(_timeout_seconds())

    # Seven questions to one resolver, run together. This is not the fan-out
    # AGENTS.md §5.5 bounds — that rule is about sources, each with its own
    # quota and rate limit. It is one resolver answering seven record types
    # concurrently, which is what dns.asyncresolver exists for; queried in
    # sequence the worst case would be seven timeouts instead of one.
    settled = await asyncio.gather(
        *(_fetch(resolver, domain, rdtype) for rdtype in RECORD_TYPES),
        return_exceptions=True,
    )

    records: dict[str, list[dict[str, Any]]] = {rdtype: [] for rdtype in RECORD_TYPES}
    missing: list[str] = []
    errors: list[dict[str, str]] = []
    nxdomain: list[str] = []
    empty: list[str] = []
    errored: list[str] = []
    cut_types: list[str] = []
    counts_truncated = False

    for rdtype, outcome in zip(RECORD_TYPES, settled):
        if isinstance(outcome, BaseException):
            # _fetch turns every DNS failure into a status, so anything still
            # raised here is a bug in this module or in a caller's resolver.
            # Re-raise instead of presenting a defect as a partial result.
            raise outcome
        if outcome.status == "nxdomain":
            nxdomain.append(rdtype)
            missing.append(rdtype)
            continue
        if outcome.status == "empty":
            empty.append(rdtype)
            missing.append(rdtype)
            continue
        if outcome.status == "error":
            errored.append(rdtype)
            errors.append({"type": rdtype, "message": outcome.message})
            continue
        rows = outcome.rows
        if len(rows) > MAX_RECORDS_PER_TYPE:
            rows = rows[:MAX_RECORDS_PER_TYPE]
            counts_truncated = True
        records[rdtype] = rows
        if any(row.get("truncated") for row in rows):
            cut_types.append(rdtype)

    return {
        "source": "DNS",
        "domain": domain,
        "records": records,
        "counts_truncated": counts_truncated,
        "missing": missing,
        "errors": errors,
        "note": _build_note(
            domain,
            nxdomain,
            empty,
            errored,
            cut_types,
            counts_truncated,
            any(records.values()),
        ),
    }
