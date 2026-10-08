"""AlienVault OTX indicator reputation and community pulse list.

This module replaces a defacement source that turned out to have no usable
public API. Everything asserted below was verified against the live API on
2026-10-08, and the docstring records the traps because the module exists to get
them right rather than to be fast.

    Base          https://otx.alienvault.com/api/v1
    Endpoint      GET /indicators/{slug}/{value}/general
    Auth          header `X-OTX-API-KEY: <raw key>` — no Bearer, no prefix.

THE ONE REQUEST
    `/general` returns the indicator record AND the embedded pulse list
    (`pulse_info.pulses`) AND the endpoint-level geo/asn for IPs. There is NO
    `/indicators/{slug}/{value}/pulses` endpoint — it 404s — so one request is
    the whole MVP and no second call is spent on pulses.

THE SLUG IS NOT THE TYPE NAME
    `domain`, `IPv4`, `IPv6`, `hostname`, `file`, `url`, `cve`. IPv4/IPv6 are
    capitalised; `/indicators/FileHash-MD5/...` 404s while `/indicators/file/...`
    works, so the documented doc enum is NOT usable as a slug.

`OTX_API_KEY` IS OPTIONAL
    Verified anonymously: `/general`, `/reputation`, `/geo`, `/malware`,
    `/url_list`, `/http_scans`, domain `/whois`, `GET /pulses/{id}`. Verified as
    key-REQUIRED (403/429): `/search/pulses`, `/search/users`,
    `/pulses/subscribed`, `/pulses/my`, `/users/me`, every write endpoint, and
    domain `/passive_dns` — IPv4 passive DNS answered anonymously while the
    domain path returned "Anonymous access to this endpoint is limited". Only
    the anonymous-capable `/general` is used here, so a deployment without a key
    still works; the key raises the ceiling rather than unlocking the source.

ANONYMOUS LIMIT — 100 REQUESTS/HOUR PER IP, AND NO HEADERS TO ADAPT TO
    There are NO rate-limit response headers, so nothing can be adapted to and
    nothing can be read back. The budget is therefore client-side, which is the
    caller's cache's job (AGENTS.md §3: SQLite cache in front of every source).

429 IS OVERLOADED — PARSE `detail`, NEVER THE STATUS CODE ALONE
    `{"detail": "Over throttling limit (100/hour)"}` is quota exhaustion ->
    "unavailable". `{"detail": "Anonymous access to this endpoint is limited.
    Please authenticate."}` is a missing key -> "not_configured". Both arrive
    with HTTP 429, and the doc enum of reason codes cannot be trusted, so the
    body text decides.

WHY `reputation` IS NOT SURFACED AS A SCORE
    The docs define no scale and no meaning for it. `/general` returns an
    always-`0` integer for IPs; the `/reputation` section returned `null` for
    every IP probed anonymously; domain responses have NO `reputation` key at
    all. A `0` could be the clamped floor of a negative scale, a "not scored"
    default, or genuinely neutral — the three imply different verdicts and none
    of them is "safe". This module therefore does NOT put `reputation` in its
    output at all. The legible signals are `pulse_info.count`, `validation[]`
    (which is where OTX itself records whitelisted/false-positive verdicts) and
    `false_positive[]`.

WHY 404 IS NOT "NOT FOUND"
    An indicator with no OTX presence returns HTTP 200 with
    `pulse_info.count == 0` and `base_indicator: {}`. The empty state keys off
    the count, and `base_indicator: {}` means "not in OTX's base set", which is
    NOT the same as benign — a widely-abused host is routinely absent from a
    curated base set.

TLP AMBER/RED ARE TREATED AS NON-PUBLIC
    LevelBlue's own SDK rule is that amber and red pulses are not for general
    distribution. The EULA does not require a consumer to propagate a TLP, but
    showing a red pulse verbatim is the kind of thing that gets an operator
    complained at, so amber/red keep only a count: name and description are
    withheld (`tlp_restricted: True`). The label is honoured exactly as
    received and never invented — an absent TLP stays "".

`whois` IS A LINK, NOT DATA
    `whois` in the `/general` response is a URL string pointing at a third-party
    WHOIS lookup, not parsed WHOIS content. It is deliberately not surfaced:
    presenting a link as WHOIS content would be a lie, and the repo already has
    `whois_service` for actual WHOIS.

REFERENCES ARE NOT A URL LIST
    Observed entries include `"Trojan:Win32/SmokeLoader"`, a
    "Google -> pnseab-ac-in-f14.1e100.net = 1e100.net" style note, and a 700-char
    run of concatenated Hybrid Analysis strings. They are rendered as truncated
    PLAIN TEXT. Nothing in this module emits a URL, so a URL-shaped entry is
    never auto-linked by any caller either.

`public` RETURNS AN INTEGER 1
    The docs say boolean. `is True` would drop every real pulse, so the value is
    read truthily. It is not part of the output contract: a private pulse is
    not surfaced in the public pulse list to begin with, so the flag has nothing
    to gate here.

ERROR CONTRACT (never raises — a threat source can only degrade a scan)
    - target is not a domain or IP        -> "unavailable", no request spent
    - private/loopback/link-local target  -> "unavailable", no request sent
    - quota 429 ("Over throttling limit") -> "unavailable", note names 100/hour
    - key-401/403 ("Anonymous access")    -> "not_configured", note names the key
    - 403 with a configured key           -> "unavailable", key never echoed
    - timeout / transport                 -> "unavailable"
    - non-JSON or unrecognised shape      -> "unavailable"
    - zero pulses                         -> "ok", count 0, NOT an error
"""

from __future__ import annotations

import ipaddress
import math
import re
from typing import Any

import httpx

from app.core.config import settings
from app.core.errors import sanitize_error
from app.core.security import is_blocked_target

SOURCE = "AlienVault OTX"
USER_AGENT = "osint-dashboard/1.0"
API_BASE = "https://otx.alienvault.com/api/v1"
GENERAL_URL = f"{API_BASE}/indicators"

# The shared history-source contract caps `findings` at 500 (AGENTS.md §4).
MAX_FINDINGS = 500
MAX_NOTE_CHARS = 500
# OTX pulse ids are UUIDs; the bound exists so a hostile payload cannot push an
# unbounded string into a persisted result_snapshot row.
MAX_ID_CHARS = 64
MAX_NAME_CHARS = 200
MAX_DESC_CHARS = 500
MAX_DATE_CHARS = 40
MAX_AUTHOR_CHARS = 120
MAX_ADVERSARY_CHARS = 120
MAX_TAG_CHARS = 60
MAX_FAMILY_CHARS = 120
MAX_COUNTRY_CHARS = 80
MAX_REFERENCE_CHARS = 200
MAX_LIST_ITEMS = 20
MAX_REFERENCE_ITEMS = 10
MAX_VALIDATION_ITEMS = 20
MAX_VALIDATION_CHARS = 200
# A DNS name is at most 253 characters; clipping stops an oversized target from
# becoming a request URL.
MAX_TARGET_CHARS = 253

# Slugs verified live. `IPv4`/`IPv6` are capitalised and the type name is NOT
# the slug: `/indicators/FileHash-MD5/...` 404s, `/indicators/file/...` works.
# Only the slug types this module can build a target for are listed, which is
# exactly domain and the two address families.
_SLUG_IPV4 = "IPv4"
_SLUG_IPV6 = "IPv6"
_SLUG_DOMAIN = "domain"

# OTX levels these labels and LevelBlue's SDK treats amber and red as
# non-public. An absent or unrecognised value is NOT coerced into one of them.
_TLP_VALUES = {"white", "green", "amber", "red"}
_TLP_RESTRICTED = {"amber", "red"}

# Verified 429/403 bodies. Matched case-insensitively on a substring, because
# the status code alone cannot tell these two apart.
_THROTTLE_MARKER = "over throttling limit"
_AUTH_MARKER = "anonymous access to this endpoint is limited"

_LABEL_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]")
_ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]")


def _timeout_seconds() -> float:
    """Per-source budget from the `scan_timeout_*` settings pattern.

    `scan_timeout_otx` exists in `Settings` (added with `otx_api_key`), but is
    read through `getattr` so this module works against a deployment whose
    config predates the field. Falls back to the Shodan budget, then to the 12s
    the sibling OTX-class sources use, rather than a number invented here.
    """
    for field in ("scan_timeout_otx", "scan_timeout_shodan"):
        value = getattr(settings, field, None)
        if value:
            return float(value)
    return 12.0


def _api_key() -> str:
    """Configured OTX key, or "" when unset. `getattr` until the field lands."""
    return str(getattr(settings, "otx_api_key", "") or "").strip()


# --- string hygiene ---------------------------------------------------------


def _clean(value: Any, limit: int) -> str:
    """Strip escapes and control characters, collapse whitespace, clip.

    A pulse name/description is community-submitted text that lands in a
    rendered table and in a persisted `result_snapshot` row, so a pasted escape
    must not survive into either. ANSI first, then control characters: deleting
    the ESC byte alone would leave a literal "[31m" glued onto the name and make
    it look like a different pulse. Never raises; non-strings become "".
    """
    if not isinstance(value, str):
        return ""
    text = _CONTROL_RE.sub("", _ANSI_RE.sub("", value))
    text = " ".join(text.split())
    return text[:limit]


def _clean_list(value: Any, item_limit: int, max_items: int) -> list[str]:
    """Clean a list-of-strings field, capped in count and in element length."""
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for item in value:
        text = _clean(item, item_limit)
        if text:
            out.append(text)
        if len(out) >= max_items:
            break
    return out


def _note(text: str) -> str:
    """Bound every note so nothing unbounded reaches the client or the cache."""
    return _clean(text, MAX_NOTE_CHARS)


# --- target resolution ------------------------------------------------------


def _slug_for(target: str) -> str | None:
    """Return the OTX slug for a target, or None when it is not a domain/IP.

    The slug is derived from the target, never guessed from a doc enum: the enum
    lists type names (`FileHash-MD5`) that 404 as a slug, and an unsupported
    target must cost no request.
    """
    try:
        address = ipaddress.ip_address(target)
    except ValueError:
        return _SLUG_DOMAIN
    return _SLUG_IPV4 if address.version == 4 else _SLUG_IPV6


def _is_queryable_domain(value: str) -> bool:
    """True for a hostname of two or more sound labels.

    Mirrors `leaklookup_service`: a single-label name cannot name a registrable
    domain, so spending a request on it buys nothing.
    """
    labels = value.split(".")
    return len(labels) >= 2 and all(_LABEL_RE.fullmatch(label) for label in labels)


def _normalize_target(target: Any) -> str:
    """Normalise and bound the target. Returns "" when it is not a target at all."""
    if not isinstance(target, str):
        return ""
    value = target.strip().lower().removeprefix("*.").rstrip(".")
    if not value or "@" in value or "/" in value or " " in value:
        # `@` is the signature of an email address and this module does not look
        # up individuals; `/` is a path, which is a `url` slug target, not ours.
        return ""
    return value[:MAX_TARGET_CHARS]


# --- payload parsing --------------------------------------------------------


def extract_geo(general_payload: dict[str, Any]) -> dict[str, Any]:
    """Pull endpoint-level geo/asn out of a `/general` payload. Pure function.

    `/general` already carries `asn`, `country_name`, `country_code`, `region`,
    `city`, `latitude` and `longitude` for an IP indicator, so the orchestrator
    can enrich its host card from the payload it already has instead of paying a
    second request for `/geo`.

    Every field is `str | float | None` and `None` means ABSENT. A missing value
    is never invented and never reported as `0`/`0.0`, because `0.0` for
    latitude or longitude is the Gulf of Guinea and `0` for asn is a real ASN
    an attacker could pick — both read as data. Domain responses carry none of
    these keys, so a domain payload yields all-None.

    Pure and network-free by design, so it is trivially testable and safe to call
    on any dict, including one the caller already has in hand.
    """
    if not isinstance(general_payload, dict):
        return {
            "asn": None,
            "country": None,
            "country_code": None,
            "region": None,
            "city": None,
            "latitude": None,
            "longitude": None,
        }

    def _text(*keys: str) -> str | None:
        """First usable string among `keys`, else None.

        A non-string here is treated as absent rather than coerced: `asn` is
        documented as an integer but arrives as text, and stringifying whatever
        turns up would let a nested object become a country name.
        """
        for key in keys:
            value = general_payload.get(key)
            if isinstance(value, str):
                cleaned = _clean(value, 120)
                if cleaned:
                    return cleaned
        return None

    def _coord(*keys: str) -> float | None:
        for key in keys:
            value = general_payload.get(key)
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                continue
            number = float(value)
            if math.isnan(number):
                continue
            return number
        return None

    return {
        "asn": _text("asn"),
        "country": _text("country_name", "country"),
        "country_code": _text("country_code"),
        "region": _text("region"),
        "city": _text("city"),
        "latitude": _coord("latitude", "latitude_"),
        "longitude": _coord("longitude", "longitude_"),
    }


def _pulse_author(pulse: dict[str, Any]) -> str:
    """Read the pulse author from either shape OTX uses.

    Inside `pulse_info.pulses[]` there is an `author` OBJECT (`{username, id,
    ...}`) and no `author_name`; `author_name` as a string appears on
    `GET /pulses/{id}`. Both are accepted so the field works whichever endpoint
    a payload came from, and neither form is echoed beyond 120 characters.
    """
    author = pulse.get("author")
    if isinstance(author, dict):
        name = _clean(author.get("username"), MAX_AUTHOR_CHARS)
        if name:
            return name
        name = _clean(author.get("name"), MAX_AUTHOR_CHARS)
        if name:
            return name
    elif isinstance(author, str):
        name = _clean(author, MAX_AUTHOR_CHARS)
        if name:
            return name
    return _clean(pulse.get("author_name"), MAX_AUTHOR_CHARS)


def _tlp_of(pulse: dict[str, Any]) -> str:
    """The TLP label exactly as received, lowercased, or "" when absent.

    Never invented: an unrecognised value becomes "" rather than being coerced
    into a label that would grant or deny visibility on a guess.
    """
    value = pulse.get("TLP")
    if not isinstance(value, str):
        return ""
    label = value.strip().lower()
    return label if label in _TLP_VALUES else ""


def _malware_families(pulse: dict[str, Any]) -> list[str]:
    """`display_name` only, from `{id, display_name, target}` entries.

    `target` is a WEB PATH like `/malware/Trojan:Win32/SmokeLoader`, not an API
    path, and is deliberately dropped rather than joined onto the base URL — a
    wrong path is a 404 at best and a request against an unintended endpoint at
    worst.
    """
    entries = pulse.get("malware_families")
    if not isinstance(entries, list):
        return []
    out: list[str] = []
    for entry in entries[:MAX_LIST_ITEMS]:
        if isinstance(entry, dict):
            name = _clean(entry.get("display_name"), MAX_FAMILY_CHARS)
        else:
            name = _clean(entry, MAX_FAMILY_CHARS)
        if name:
            out.append(name)
    return out


def _indicator_types(pulse: dict[str, Any]) -> list[str]:
    """The keys of `indicator_type_counts`, capped.

    The dict is sparse and keyed by TYPE NAME (`FileHash-MD5`, `URL`, `domain`,
    `IPv4`), not by slug — that is OTX's own key vocabulary and is left
    verbatim so the UI does not have to guess at a mapping. Counts are dropped:
    the pulse count is the headline number and a per-type count would invite the
    reader to sum types as if they were disjoint.
    """
    counts = pulse.get("indicator_type_counts")
    if not isinstance(counts, dict):
        return []
    out: list[str] = []
    for key in counts:
        name = _clean(key, MAX_TAG_CHARS)
        if name:
            out.append(name)
        if len(out) >= MAX_LIST_ITEMS:
            break
    return out


def _pulse_finding(pulse: Any) -> dict[str, Any] | None:
    """One bounded finding from one pulse. None when the entry is unusable."""
    if not isinstance(pulse, dict):
        return None
    pulse_id = _clean(pulse.get("id"), MAX_ID_CHARS)
    tlp = _tlp_of(pulse)
    restricted = tlp in _TLP_RESTRICTED
    # A pulse with no usable id cannot be referenced by the reader, so it is
    # skipped rather than emitted with a blank id.
    if not pulse_id:
        return None
    return {
        "pulse_id": pulse_id,
        "name": "" if restricted else _clean(pulse.get("name"), MAX_NAME_CHARS),
        "description": (
            "" if restricted else _clean(pulse.get("description"), MAX_DESC_CHARS)
        ),
        "created": _clean(pulse.get("created"), MAX_DATE_CHARS),
        "modified": _clean(pulse.get("modified"), MAX_DATE_CHARS),
        "author": _pulse_author(pulse),
        "tlp": tlp,
        "tlp_restricted": restricted,
        "tags": _clean_list(pulse.get("tags"), MAX_TAG_CHARS, MAX_LIST_ITEMS),
        "malware_families": _malware_families(pulse),
        "adversary": _clean(pulse.get("adversary"), MAX_ADVERSARY_CHARS),
        "attack_ids": _clean_list(pulse.get("attack_ids"), 60, MAX_LIST_ITEMS),
        "targeted_countries": _clean_list(
            pulse.get("targeted_countries"), MAX_COUNTRY_CHARS, MAX_LIST_ITEMS
        ),
        "indicator_types": _indicator_types(pulse),
        "references": _clean_list(
            pulse.get("references"), MAX_REFERENCE_CHARS, MAX_REFERENCE_ITEMS
        ),
    }


def _validation(payload: dict[str, Any]) -> list[dict[str, str]]:
    """OTX's own verdicts on the indicator: whitelist / false-positive records.

    This is the field that says OTX considers the indicator benign, and it is
    far more legible than `reputation`. Capped in count and per-field length.
    """
    entries = payload.get("validation")
    if not isinstance(entries, list):
        return []
    out: list[dict[str, str]] = []
    for entry in entries[:MAX_VALIDATION_ITEMS]:
        if not isinstance(entry, dict):
            continue
        out.append(
            {
                "source": _clean(entry.get("source"), MAX_VALIDATION_CHARS),
                "message": _clean(entry.get("message"), MAX_VALIDATION_CHARS),
                "name": _clean(entry.get("name"), MAX_VALIDATION_CHARS),
            }
        )
    return out


def _false_positive(payload: dict[str, Any]) -> list[dict[str, str]]:
    """Community false-positive assessments recorded against the indicator."""
    entries = payload.get("false_positive")
    if not isinstance(entries, list):
        return []
    out: list[dict[str, str]] = []
    for entry in entries[:MAX_VALIDATION_ITEMS]:
        if not isinstance(entry, dict):
            continue
        out.append(
            {
                "assessment": _clean(entry.get("assessment"), MAX_VALIDATION_CHARS),
                "assessment_date": _clean(entry.get("assessment_date"), MAX_DATE_CHARS),
                "report_date": _clean(entry.get("report_date"), MAX_DATE_CHARS),
            }
        )
    return out


def _pulse_count(payload: dict[str, Any], pulses: list[Any]) -> int:
    """The headline number: how many community pulses mention this indicator.

    `pulse_info.count` is used when it is a real integer, because it is the
    total even when the embedded list is clipped. It falls back to `len()`
    otherwise. Either way the number is "pulses that mention this", never
    "threats found" — there is no severity attached to any of them.
    """
    info = payload.get("pulse_info")
    if isinstance(info, dict):
        count = info.get("count")
        if isinstance(count, bool):
            return len(pulses)
        if isinstance(count, int):
            return count
        if isinstance(count, float) and count == int(count):
            return int(count)
    return len(pulses)


def _ok_note(count: int, restricted: int, truncated: bool) -> str:
    """An honest note about what the number does and does not mean."""
    if count == 0:
        return (
            "No OTX community pulses mention this indicator. OTX pulse coverage is "
            "opt-in community submission, so an empty result means nothing has "
            "been shared here — not that the target is safe or benign."
        )
    headline = (
        f"{count} OTX community pulse(s) mention this indicator; each is a "
        "third-party submission, not a confirmed finding, and none of them "
        "carries a severity score."
    )
    disclaimer = (
        "Absence of pulses means nothing has been shared, not that the target is "
        "safe."
    )
    parts = [headline, disclaimer]
    if restricted:
        parts.append(
            f"{restricted} pulse(s) are labelled TLP amber or red and are treated as "
            "non-public: they are counted but their names and descriptions are not "
            "shown."
        )
    if truncated:
        parts.append(
            f"Only the first {MAX_FINDINGS} pulses are listed; the count above is the "
            "full total."
        )
    return " ".join(parts)


def _result(
    status: str,
    count: int,
    findings: list[dict[str, Any]],
    truncated: bool,
    note: str,
    *,
    in_base_set: bool = False,
    validation: list[dict[str, str]] | None = None,
    false_positive: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    """Build the shared history-source contract, plus the legible signals.

    The first seven keys are the contract every history source returns. The
    rest are OTX-specific signals the UI needs in order to stay honest:
    `pulse_count`, `in_base_set`, `validation` and `false_positive`.

    `reputation` is deliberately absent. See the module docstring: the docs
    define no scale for it, `/general` returns an always-`0` integer for IPs and
    `/reputation` returned `null` for every IP probed anonymously, so any
    rendering of it as a score would be a guess. `pulse_info.count`,
    `validation[]` and `false_positive[]` have legible semantics.
    """
    return {
        "source": SOURCE,
        "status": status,
        "count": count,
        "findings": findings,
        "truncated": truncated,
        "note": _note(note),
        "pulse_count": count,
        "in_base_set": in_base_set,
        "validation": validation or [],
        "false_positive": false_positive or [],
    }


def _unavailable(note: str) -> dict[str, Any]:
    return _result("unavailable", 0, [], False, note)


def _detail_of(response: httpx.Response) -> str:
    """The `detail` string from an OTX error body, or "" when absent.

    Parsed defensively: the body may not be JSON at all, and `detail` may be a
    list or an object rather than a string. The text is cleaned but never
    returned raw into a note on its own — `_error_note` maps it to a sentence
    written here.
    """
    try:
        body = response.json()
    except ValueError:
        return ""
    if not isinstance(body, dict):
        return ""
    detail = body.get("detail")
    if isinstance(detail, str):
        return _clean(detail, 300)
    return ""


def _error_note(status_code: int, detail: str, has_key: bool) -> tuple[str, str]:
    """Map an OTX error to (status, note). Never echoes the key.

    The 429 branch parses `detail`, because 429 is overloaded: quota exhaustion
    and a missing key both arrive as 429 with different bodies, and calling one
    of them the other would send the operator to the wrong fix.
    """
    lowered = detail.lower()
    if _THROTTLE_MARKER in lowered:
        throttled = (
            "OTX rate limiting: the 100 requests/hour anonymous allowance for this "
            "IP is exhausted, and OTX sends no rate-limit headers to adapt to. "
            "Rate limited — retry after the allowance resets."
        )
        return ("unavailable", throttled)
    if _AUTH_MARKER in lowered or "please authenticate" in lowered:
        anonymous = (
            "OTX refused this request as anonymous. A free OTX_API_KEY unlocks the "
            "key-only endpoints (pulse search, passive DNS for domains) and raises "
            "the anonymous limit."
        )
        return ("not_configured", anonymous)
    if status_code in (401, 403):
        # A configured key that OTX rejects. The key is never echoed: this note is
        # persisted to scans.result_snapshot and rendered in history.
        if has_key:
            rejected = (
                "OTX rejected the configured API key. Check OTX_API_KEY — the key "
                "value is never shown here."
            )
            return ("unavailable", rejected)
        refused = (
            "OTX refused this request without an API key. Set OTX_API_KEY (free) to "
            "unlock the key-only endpoints."
        )
        return ("not_configured", refused)
    if status_code == 429:
        # A 429 whose body we could not classify. Unavailable, not
        # not_configured: without the body there is no evidence a key is what is
        # missing, and claiming one would be a guess.
        unclassified = (
            "OTX rate limiting (HTTP 429). OTX sends no rate-limit headers, so the "
            "quota state cannot be confirmed — retry later."
        )
        return ("unavailable", unclassified)
    generic = (
        f"OTX lookup failed (HTTP {status_code}). The indicator may not exist in "
        "OTX, or the service may be degraded."
    )
    return ("unavailable", generic)


async def lookup(
    target: str, client: httpx.AsyncClient | None = None
) -> dict[str, Any]:
    """Return community pulse history for one domain or IP from AlienVault OTX.

    Args:
        target: a hostname or a public IPv4/IPv6 literal. `*.` prefixes and
            trailing dots are normalised away and the value is clipped to 253
            characters. A private address and `localhost` are refused without any
            request being sent.
        client: optional shared `httpx.AsyncClient`. When None a private client
            is created and closed here; an injected client is never closed.
            `User-Agent` is set on the request either way.

    Returns:
        The shared history-source contract plus OTX's legible signals:
        `{"source", "status", "count", "findings", "truncated", "note",
        "pulse_count", "in_base_set", "validation", "false_positive"}`.
        `status` is "ok", "unavailable" or "not_configured". `count` and
        `pulse_count` are both the number of community pulses mentioning the
        indicator. Each finding is one pulse, with TLP amber/red names and
        descriptions withheld (`tlp_restricted: True`). `in_base_set` is
        `bool(base_indicator)` and means only "OTX's base set contains this",
        NOT "benign". `reputation` is intentionally absent from the output.

    Never raises: every failure is an `unavailable`/`not_configured` result with
    a sanitised note, so a threat-intel source can only ever degrade a scan into
    a partial result.
    """
    query = _normalize_target(target)
    if not query:
        return _unavailable(
            "Target is not a domain or IP address. OTX is queried here only for "
            "network indicators — no emails, file hashes, URLs or individuals."
        )
    if is_blocked_target(query):
        # Pre-flight, using the repo's own check. OTX's own 400 for a private
        # address is weaker and differently shaped; refusing here costs nothing.
        return _unavailable(
            "Target is a private, loopback or link-local address — not sent to OTX."
        )

    slug = _slug_for(query)
    if slug == _SLUG_DOMAIN and not _is_queryable_domain(query):
        return _unavailable(
            "Target is not a valid domain name or IP address, so no request was "
            "spent on it."
        )

    api_key = _api_key()
    timeout = _timeout_seconds()
    headers = {"User-Agent": USER_AGENT}
    if api_key:
        # Raw key, no Bearer and no prefix (verified live).
        headers["X-OTX-API-KEY"] = api_key

    own = client is None
    if own:
        client = httpx.AsyncClient(headers=headers)

    try:
        try:
            response = await client.get(
                f"{GENERAL_URL}/{slug}/{query}/general",
                headers=headers,
                timeout=timeout,
            )
        except (httpx.TimeoutException, TimeoutError):
            return _unavailable(
                f"OTX timed out after {timeout:g}s. The 100 requests/hour anonymous "
                "allowance is also a plausible cause — retry later."
            )
        except httpx.HTTPError as exc:
            # sanitize_error handles the key-shaped text an httpx message can
            # carry. The type name alone is the fallback when there is no
            # response object to read a status from.
            note = sanitize_error(SOURCE, exc)
            return _unavailable(note)
        except Exception as exc:  # noqa: BLE001 — never raise to the router
            return _unavailable(sanitize_error(SOURCE, exc))

        status_code = response.status_code
        if status_code >= 400:
            # One request, no retry: a retry loop against an hourly per-IP quota
            # is how a shared egress IP gets its whole hour burnt.
            error_status, error_note = _error_note(
                status_code, _detail_of(response), bool(api_key)
            )
            return _result(error_status, 0, [], False, error_note)

        try:
            payload = response.json()
        except ValueError:
            return _unavailable("OTX returned a response that was not JSON.")
        if not isinstance(payload, dict):
            return _unavailable("OTX returned an unrecognised response shape.")

        info = payload.get("pulse_info")
        if not isinstance(info, dict):
            # `pulse_info` missing means the shape is not the documented one.
            # Treated as a failure rather than as "zero pulses": a wrong shape and
            # an indicator nobody has written about must not look alike.
            return _unavailable(
                "OTX returned an unrecognised response shape (no pulse_info)."
            )

        pulses = info.get("pulses")
        pulses = pulses if isinstance(pulses, list) else []
        count = _pulse_count(payload, pulses)
        truncated = count > len(pulses) or len(pulses) > MAX_FINDINGS

        findings: list[dict[str, Any]] = []
        restricted = 0
        for pulse in pulses[:MAX_FINDINGS]:
            finding = _pulse_finding(pulse)
            if finding is None:
                continue
            if finding["tlp_restricted"]:
                restricted += 1
            findings.append(finding)

        # `base_indicator` is `{}` when the indicator is not in OTX's base set,
        # and `{}` is NOT benign — it only means absence from a curated set.
        in_base_set = bool(payload.get("base_indicator"))

        return _result(
            "ok",
            count,
            findings,
            truncated,
            _ok_note(count, restricted, truncated),
            in_base_set=in_base_set,
            validation=_validation(payload),
            false_positive=_false_positive(payload),
        )
    finally:
        if own and client is not None:
            await client.aclose()
