"""Host enrichment: the IP/ASN/geo/hosting view the Shodan payload already paid for.

WHAT THIS IS
    A pure, synchronous normaliser over the dict a Shodan host lookup already
    produced. It answers "where is this host, who announces it, what does it
    look like" from data Shodan has already collected — it never asks anyone
    anything. `enrich()` takes a dict and returns a dict: no HTTP client, no
    socket, no resolver, no reverse DNS, no ASN service, no database, no cache,
    no clock. That is the whole design point. A module that cannot open a
    connection cannot become an active scanner, and a pure function is trivially
    testable; `tests/test_host_enrichment_service.py` AST-parses this file and
    fails if a networking import ever appears.

WHY IT EXISTS (the diff-first finding)
    Shodan's host response already carries every field the v2 TODO asks for:
    `ip`, `asn` (as "AS13335 Cloudflare, Inc."), `isp`, `org`, `city`,
    `region_code`, `country_name`, `country_code`, `postal_code`, `latitude`,
    `longitude`, `timezone`, `network`, `domain`, `os`, `hostnames` and
    `ports`/`data`. No second paid key is needed and none is wanted: Censys,
    MaxMind and ipinfo would re-buy data we are already being handed.

    What was missing is the *pass-through*. `shodan_service.lookup()` reduces
    the response to nine keys and drops eleven of the above, so the scan result
    cannot show a map pin or an ASN. This module reads either that normalised
    dict (keys `services`, empty-string sentinels) or a raw Shodan host
    response (keys `data`, real banner strings), so the view can be built from
    whichever the caller holds.

WHAT THIS IS NOT — AND WHY
    - **Not a port scanner.** `open_ports` is derived strictly from what Shodan
      already recorded. Nothing here opens a socket, connects to a port, or
      sends a packet, and no `nmap` wrapper exists — AGENTS.md §7 excludes active
      scanning from v1, and an unapproved binary would come with it. If Shodan
      has no port data the list is empty and the `note` says so.
    - **Not a geoIP product.** Coordinates come from Shodan's own record. They
      are IP-block centroids, not a building, which is why they are rendered as
      an approximate location rather than a precise one.
    - **Not a resolver.** No PTR/reverse DNS, no WHOIS, no traceroute: each is
      a new network call and a new place for a scan to hang.

ERROR CONTRACT
    `shodan_payload` may be None, not a dict, or hold wrongly-typed values, and
    no input raises. The payload is untrusted external data (AGENTS.md §5.4):
    Shodan returns what a target chose to send, and a non-string where a city
    should be is a field Shodan did not report, not a city called "123". Absent
    fields are `None` — never "" , never 0, never 0.0 — so a missing city can
    never render as "unknown, 0,0" and be read as a real location.

    Every emitted string is bounded (200 chars for org/isp/city/country/network/
    domain/os, 253 for hostnames, 2KB for a banner) and every list is capped
    (100 hostnames, 500 ports) with an explicit `ports_truncated` flag. The
    banner bound matches `shodan_service._truncate`, which already cuts the
    same attacker-controlled bytes at 2KB.
"""

from __future__ import annotations

from typing import Any

# What the UI shows in its source column. Says "passive" so a row stays
# self-labelling in history and export without a router having to add it.
SOURCE = "Shodan (passive host data)"

MAX_VALUE_CHARS = 200
MAX_IP_CHARS = 45  # 45.0.0.0 in IPv6 presentation form; an IP is never longer.
MAX_TIMEZONE_CHARS = 64  # "America/Argentina/ComodRivadavia" and friends
MAX_TRANSPORT_CHARS = 20  # "tcp", "udp", "sctp"
MAX_PRODUCT_CHARS = 200  # matches shodan_service's product bound
MAX_VERSION_CHARS = 100  # matches shodan_service's version bound
# The banner is bytes the target itself sent. shodan_service._truncate already
# cuts this at 2KB and the same bound is kept here, so normalising a host never
# loosens the ceiling the fetch path set.
MAX_BANNER_CHARS = 2048
MAX_HOSTNAME_CHARS = 253  # the DNS name length limit
MAX_HOSTNAMES = 100
MAX_PORTS = 500  # the same ceiling shodan_service applies to `ports`

# How many raw list entries are walked while collecting unique values. A payload
# can repeat one port a million times; walking all of it would turn a defensive
# normaliser into a denial-of-service, so the walk stops and says it stopped.
MAX_SCAN_ITEMS = 5000

MAX_NOTE_CHARS = 500  # matches the orchestrator's per-message bound

# First and unconditional in every note, so the passivity promise survives the
# note's length bound: an empty port list is an absence of data, not a scan that
# found nothing open.
PASSIVE_NOTE = (
    "Ports are read from Shodan's passive records; this module never probes a "
    "target (AGENTS.md §7)."
)

# Descriptive fields reported as absent when Shodan did not supply them. The
# note names them so a reader can tell "Shodan has nothing on this host" from
# "we did not look" — this module only ever looks at what was handed to it.
_REPORTABLE = (
    "asn",
    "asn_org",
    "isp",
    "org",
    "city",
    "region",
    "country",
    "country_code",
    "postal_code",
    "latitude",
    "longitude",
    "timezone",
    "network",
    "domain",
    "os",
)


def _text(value: Any, limit: int = MAX_VALUE_CHARS) -> str | None:
    """Bound an untrusted string, or report it as absent.

    Deliberately not `str(value)`. shodan_service coerces with `str(... or "")`,
    so this module cannot always tell a coerced value from a real one — but it
    can refuse to coerce *itself*. A field that arrived as `123`, a list or a
    dict is a field Shodan did not report, and rendering it as "123" would put
    a value on screen that no source ever observed.
    """
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped[:limit] if stripped else None


def _first_text(payload: dict[str, Any], *keys: str) -> str | None:
    """The first non-empty string among `keys`.

    The two shapes disagree on names: `shodan_service` renames Shodan's
    `country_name` to `country` and drops `region_code` entirely, while a raw
    response keeps both original names. Trying each in turn reads either.
    """
    for key in keys:
        text = _text(payload.get(key))
        if text is not None:
            return text
    return None


def _coordinate(value: Any, limit: float) -> float | None:
    """A latitude/longitude as a float, or None. Never string-coerced.

    The range test is also what rejects NaN and ±inf, so no `math` import is
    needed: every comparison against NaN is False, making `not (-90 <= nan <=
    90)` True, and an infinity is out of range on its own. A bool is rejected
    first because `float(True)` is 1.0 — a real latitude in the Gulf of Guinea.
    """
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if -limit <= number <= limit else None


def _split_asn(value: str | None) -> tuple[str | None, str | None]:
    """Split Shodan's single `asn` string into an ASN and the org behind it.

    Shodan returns `"AS13335 Cloudflare, Inc."` in one field, so the AS number
    and its registered organisation are not two API fields: one of them has to be
    separated for the UI to sort, filter or link on the number alone.
    """
    if value is None:
        return None, None
    head, separator, tail = value.partition(" ")
    digits = head[2:] if head.startswith("AS") else ""
    if separator and digits.isascii() and digits.isdigit():
        return head, _text(tail)
    # "AS1234" on its own, or something unrecognised: keep it whole rather than
    # inventing a split.
    return value, None


def _port(value: Any) -> int | None:
    """A usable port number, or None. A bool is not a port.

    Shodan sends ints, but this payload is untrusted (AGENTS.md §5.4), so 0, a
    negative number, 65536, a float like 80.5 and the string "443" are all
    skipped rather than coerced into something that looks like a real port.
    """
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if 1 <= value <= 65535 else None


def _transport(value: Any) -> str:
    """Transport protocol, defaulting to tcp exactly as the Shodan payload does."""
    return (_text(value, MAX_TRANSPORT_CHARS) or "tcp").lower()


def _service_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Per-port entries, from whichever of the two shapes arrived.

    `shodan_service.lookup()` renames Shodan's `data` to `services` and puts
    the banner under `banner`; a raw Shodan host response keeps `data` with the
    banner in `data`. Both are read, so this works on the normalised scan result
    and on the raw response alike. A `data` that is a string or a dict — Shodan
    uses that key differently on other endpoints — yields no rows rather than a
    crash.
    """
    for key in ("services", "data"):
        rows = payload.get(key)
        if isinstance(rows, (list, tuple)):
            return [row for row in rows if isinstance(row, dict)]
    return []


def _record(
    found: dict[tuple[int, str], dict[str, Any]],
    port: int,
    transport: str,
    product: str | None,
    version: str | None,
    banner: str | None,
) -> None:
    """Record one port, merging a duplicate rather than overwriting evidence.

    A port is usually named twice: once in the flat `ports` list, which carries
    no detail, and again in the per-service entry that does. Keeping the first
    read would let the bare entry erase the product and banner, so a later
    duplicate only fills a field the earlier one left empty.
    """
    key = (port, transport)
    entry = found.get(key)
    if entry is None:
        found[key] = {
            "port": port,
            "transport": transport,
            "product": product,
            "version": version,
            "banner": banner,
        }
        return
    for field, value in (
        ("product", product),
        ("version", version),
        ("banner", banner),
    ):
        if entry[field] is None and value is not None:
            entry[field] = value


def _open_ports(
    payload: dict[str, Any], rows: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], bool, int]:
    """Passive open ports, deduped, sorted numerically, capped.

    Sources in order: the flat `ports` list, then each per-service entry. A port
    named only in `ports` keeps `product: None` — that is Shodan not knowing the
    product, not this module declining to look.

    The whole input is walked rather than stopped at the cap, because the note
    can then state how many entries were omitted instead of merely that some
    were. The walk is bounded by MAX_SCAN_ITEMS, which is what keeps a payload
    repeating one port a million times from becoming a denial of service.

    Returns the kept entries, whether anything was dropped, and how many unique
    ports were seen in total (before the cap).
    """
    found: dict[tuple[int, str], dict[str, Any]] = {}
    scanned = 0
    scan_capped = False

    flat = payload.get("ports")
    if isinstance(flat, (list, tuple)):
        for item in flat:
            if scanned >= MAX_SCAN_ITEMS:
                scan_capped = True
                break
            scanned += 1
            port = _port(item)
            if port is not None:
                _record(found, port, "tcp", None, None, None)

    for row in rows:
        if scanned >= MAX_SCAN_ITEMS:
            scan_capped = True
            break
        scanned += 1
        port = _port(row.get("port"))
        if port is None:
            continue
        # Both banner spellings are bounded at 2KB: reading `banner` at the
        # default 200 would quietly tighten the ceiling shodan_service set.
        _record(
            found,
            port,
            _transport(row.get("transport")),
            _text(row.get("product"), MAX_PRODUCT_CHARS),
            _text(row.get("version"), MAX_VERSION_CHARS),
            _text(row.get("banner"), MAX_BANNER_CHARS)
            or _text(row.get("data"), MAX_BANNER_CHARS),
        )

    over_cap = len(found) > MAX_PORTS
    # Sorting on the (port, transport) key orders numerically by port, then
    # alphabetically by protocol, so the UI never has to re-sort.
    kept = [found[key] for key in sorted(found)][:MAX_PORTS]
    return kept, over_cap or scan_capped, len(found)


def _hostnames(
    payload: dict[str, Any], rows: list[dict[str, Any]]
) -> tuple[list[str], bool]:
    """Hostnames recorded for this IP, deduped and capped.

    Three passive sources: the host's `hostnames` list, its `domains` list, and
    a `hostname` carried on individual service entries. Comparison is
    case-folded and trailing-dot-stripped because those are the same name.
    """
    sources: list[Any] = []
    for key in ("hostnames", "domains"):
        names = payload.get(key)
        if isinstance(names, (list, tuple)):
            sources.extend(names)
    sources.extend(row["hostname"] for row in rows if row.get("hostname") is not None)

    seen: list[str] = []
    known: set[str] = set()
    truncated = False
    for scanned, item in enumerate(sources):
        if scanned >= MAX_SCAN_ITEMS:
            truncated = True
            break
        name = _text(item, MAX_HOSTNAME_CHARS)
        if name is None:
            continue
        folded = name.lower().rstrip(".")
        if folded in known:
            continue
        known.add(folded)
        seen.append(name)
        if len(seen) > MAX_HOSTNAMES:
            truncated = True
            break
    return seen[:MAX_HOSTNAMES], truncated


def _note(
    ports: list[dict[str, Any]],
    ports_found: int,
    ports_truncated: bool,
    hostnames_truncated: bool,
    missing: list[str],
) -> str:
    """State what is not known, in one bounded line.

    The passivity sentence leads so it is never the part that gets cut. After
    it, each clause names a specific gap: an empty port list means Shodan had no
    port data (not that every port is closed), a cap says how many entries were
    omitted, and a host about which Shodan says nothing lists its absent fields
    instead of leaving the reader to assume defaults. Clauses are already whole
    sentences and are joined with a space, so the note reads as prose.
    """
    parts = [PASSIVE_NOTE]
    if not ports:
        parts.append(
            "Shodan reported no port data for this host, so open_ports is empty "
            "- absence of data, not evidence that every port is closed."
        )
    dropped = ports_found - len(ports)
    if ports_truncated and dropped > 0:
        plural = "entry was" if dropped == 1 else "entries were"
        parts.append(
            f"{dropped} further passive port {plural} omitted (cap {MAX_PORTS})."
        )
    elif ports_truncated:
        parts.append(f"Port input stopped after {MAX_SCAN_ITEMS} entries scanned.")
    if hostnames_truncated:
        parts.append(f"Hostname list capped at {MAX_HOSTNAMES}.")
    if missing:
        parts.append("Not returned by Shodan: " + ", ".join(missing) + ".")
    return " ".join(parts)[:MAX_NOTE_CHARS]


def enrich(shodan_payload: dict[str, Any] | None) -> dict[str, Any]:
    """Normalise an already-fetched Shodan host payload into a UI-ready view.

    Accepts either the dict `shodan_service.lookup()` returns or a raw Shodan
    host response. Pure, synchronous and total: no I/O, no clock, no randomness,
    and no input — `None`, a list, or a payload of wrong types included — raises.
    A scan degrades to a partial result, never to a 500 (AGENTS.md §5.4).

    `port_count` always equals `len(open_ports)`. The number of ports seen
    before the cap is deliberately not returned as the count, so the figure a
    chart renders and the number of rows behind it can never disagree; the
    omitted total lives in `note`, next to `ports_truncated`.
    """
    payload = shodan_payload if isinstance(shodan_payload, dict) else {}
    rows = _service_rows(payload)
    ports, ports_truncated, ports_found = _open_ports(payload, rows)
    hostnames, hostnames_truncated = _hostnames(payload, rows)

    asn, asn_org = _split_asn(_first_text(payload, "asn"))
    result: dict[str, Any] = {
        "source": SOURCE,
        # `ip` is what we asked Shodan about, so it comes back from the
        # normalised result; a raw response calls the same value `ip_str`.
        "ip": _text(payload.get("ip"), MAX_IP_CHARS)
        or _text(payload.get("ip_str"), MAX_IP_CHARS),
        "asn": asn,
        "asn_org": asn_org,
        "isp": _first_text(payload, "isp"),
        # Shodan's `org` is the hosting organisation; the ASN's registered name
        # is the honest stand-in when `org` was dropped in normalisation.
        "org": _first_text(payload, "org") or asn_org,
        "city": _first_text(payload, "city"),
        # Shodan publishes a region *code* and no region name.
        "region": _first_text(payload, "region", "region_code"),
        "country": _first_text(payload, "country_name", "country"),
        "country_code": _first_text(payload, "country_code"),
        "postal_code": _text(payload.get("postal_code")),
        "latitude": _coordinate(payload.get("latitude"), 90.0),
        "longitude": _coordinate(payload.get("longitude"), 180.0),
        "timezone": _text(payload.get("timezone"), MAX_TIMEZONE_CHARS),
        "network": _first_text(payload, "network"),
        "domain": _first_text(payload, "domain"),
        "os": _first_text(payload, "os"),
        "hostnames": hostnames,
        "open_ports": ports,
        "port_count": len(ports),
        "ports_truncated": ports_truncated,
    }
    result["note"] = _note(
        ports,
        ports_found,
        ports_truncated,
        hostnames_truncated,
        [name for name in _REPORTABLE if result[name] is None],
    )
    return result
