"""Leak-Lookup breach-exposure lookup, aggregate counts only (backend only).

Verified 2026-10-08 against Leak-Lookup's own published documentation:
https://leak-lookup.com/docs/search, https://leak-lookup.com/support/api and
https://leak-lookup.com/support/terms. Everything asserted below is quoted from
those three pages; nothing here was confirmed against a live response, because
confirming it would require a real key and a real breach query.

    Endpoint     POST https://leak-lookup.com/api/search
                 Form-encoded body (`curl -d`), i.e. the key travels in the BODY
                 and never in a URL. `key`, `type` and `query` are all required.
    API key      REQUIRED. The TODO entry for this source recorded "public, no
                 key" — that is wrong. Every account is issued a free *public*
                 key, but a key is still needed to call the endpoint at all.
    Rate limits  Public key: 10 requests/day (docs/search, "API Key") plus a
                 secondary "RATE LIMIT REACHED — more than 5 requests in the
                 last minute" guard (docs/search, "Error Messages"). Private key:
                 a "fixed daily request rate" quoted case-by-case
                 (support/api) and a 10,000-results-per-query cap.
    ToS          support/terms: "You may only use the service for your own
                 personal security and research" and only for "yourself or those
                 who are authorized in writing to do so"; "Searching for
                 information on others without their consent is strictly
                 prohibited"; "Mass-Domain queries of unauthorized domains"
                 risk "immediate termination"; API keys must be registered with
                 support before being resold. support/api adds that API users
                 "must strictly vet any searches performed using their API key"
                 and that abuse means immediate termination.
    Attribution  No attribution requirement appears anywhere in the published
                 ToS. UNVERIFIED whether support expects a credit off-API.

WHAT THIS MODULE DELIBERATELY DOES NOT DO
    It queries only the `domain` and `ipaddress` search types. The documented
    `email_address`, `username`, `phone`, `fullname` and `password` types are
    NOT wired up, and a target that is not a domain or IP is refused rather
    than guessed at. Two reasons, and they agree: the ToS restricts this source
    to searches you are authorised to run, and a breach tool that will look up
    an arbitrary named individual is not something this dashboard should expose
    to every signed-in user.

THE PII RULE — THIS IS THE POINT OF THE MODULE
    A private-key search response is a list of leaked credential ROWS: the
    plaintext-or-hashed password, the salt, the account's email address, and
    often its name, phone and postal code. That is the most dangerous payload
    any module in this repo can be handed.

    Those raw credentials are fetched transiently in memory, read only to take
    `len()` of each breach's row list, and then deliberately discarded. They are
    never returned by this module, never logged, never written to the cache, and
    never persisted to `scans.result_snapshot`. What leaves this module is
    aggregate shape only: the number of breach names, and per breach name the
    breach name, an optional date and a COUNT. No identity, no email address, no
    username, no password, no hash, no salt, and never the raw match list.
    `tests/test_leaklookup_service.py` plants a realistic leaked pair in a
    mocked response and asserts neither the address nor the hash appears
    anywhere in `json.dumps(result)`.

PUBLIC vs PRIVATE KEY — WHY `count` CAN BE 0 ON A BREACHED TARGET
    docs/search documents two response shapes. A public key returns breach names
    only, with every indexed column stripped: `{"error": "false", "message":
    {"breach_sitename_1": [], ...}}`. A private key returns the actual rows
    under each breach name. So on a public key the per-breach match count is
    genuinely NOT KNOWABLE, and this module reports `matches: None` and a
    `count` of 0 with a note that says 0 means "not countable", never "clean".
    Collapsing those two would let a breached target render as a clean one.

ERROR CONTRACT (never raises — a router can never turn a bad source into a 500)
    - no API key configured            -> status "not_configured", no request sent
    - target is an address or a blank  -> status "unavailable", no request sent
    - target is private/localhost      -> status "unavailable", no request sent
    - target is not a valid domain     -> status "unavailable", no request spent
    - HTTP 429, or the documented      -> status "unavailable", note names rate
      REQUEST/RATE LIMIT REACHED codes    limiting. There is deliberately no
                                          retry: the public tier is 10/day.
    - timeout / transport failure      -> status "unavailable"
    - non-JSON, or unrecognised shape  -> status "unavailable"
    - any other HTTP >= 400            -> status "unavailable", status code only
    - documented "no results" shape    -> status "ok", count 0 (a HEALTHY answer)

ERROR TEXT HYGIENE
    `orchestrator.sanitize_error` is the reference for user-safe error strings.
    It is reimplemented here rather than imported because this module will be
    fanned out from the orchestrator, so a module-level import of the
    orchestrator from a service it imports would be a cycle. The redaction is
    kept byte-compatible with it, then adds an email-shaped scrub and a
    credential-shaped `field=value` scrub, so a value an unexpected upstream
    error echoes back cannot reach a note that is persisted and rendered.
    Pattern redaction cannot be exhaustive; the structural guarantee — that
    credential row data never reaches an error path at all — is the real one.
"""

from __future__ import annotations

import ipaddress
import re
from typing import Any

import httpx

from app.core.config import settings
from app.core.security import is_blocked_target

SOURCE = "Leak-Lookup"
USER_AGENT = "osint-dashboard/1.0"

# docs/search, "Endpoint": "All 'search' API requests should be sent as a POST
# request to the following endpoint".
API_URL = "https://leak-lookup.com/api/search"

# The shared history-source contract caps `findings` at 500 (AGENTS.md §4).
MAX_FINDINGS = 500
MAX_NAME_CHARS = 120
MAX_DATE_CHARS = 32
MAX_NOTE_CHARS = 300
# A DNS name is at most 253 characters; clipping to the same bound keeps an
# oversized target from being pushed into a paid query.
MAX_QUERY_CHARS = 253


def _timeout_seconds() -> float:
    """Budget from the `scan_timeout_*` settings pattern, never a local magic number.

    `scan_timeout_leaklookup` arrives with the settings field (see NEEDS
    INTEGRATION). Until it exists, the existing Shodan budget is the documented
    stand-in rather than a number invented in this module.
    """
    return float(
        getattr(settings, "scan_timeout_leaklookup", settings.scan_timeout_shodan)
    )


def _api_key() -> str:
    """Configured key, or "" when unset. `getattr` until the settings field lands."""
    return str(getattr(settings, "leaklookup_api_key", "") or "").strip()


# --- string hygiene ---------------------------------------------------------
# Control characters and DEL, then colour/cursor escapes: a breach name is
# attacker-influenced text that lands in a rendered table and in a persisted
# result_snapshot row, so a pasted escape must not survive into either.
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]")
_ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]")

# Kept byte-compatible with orchestrator.sanitize_error's two key redactions,
# then extended with an email-shaped scrub: a breach source is entitled to hand
# back an address in an error string, and "the error path is sanitised" has to
# be true of that too.
_KEY_QUERY_RE = re.compile(r"([?&]key=)[^&\s]+")
_KEY_BARE_RE = re.compile(r"key=\S+")
_EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
# `password=`, `hash=`, `salt=`, … — see _scrub for why this layer exists.
_SECRET_ASSIGN_RE = re.compile(
    r"(?i)\b(password|passwd|pass|pwd|hash|salt|secret|token|api[_-]?key)"
    r"(\s*[=:]\s*)\S+"
)

# DNS label, matching the rule app/services/certspotter_service.py already uses.
_LABEL_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")

# Documented response fields that may carry a breach date (docs/search,
# "Fields"). The API documents the COLUMN names but does NOT document that any
# of these three is ever present, and it documents no date field at all — so the
# date is best-effort and is reported as None whenever it is absent.
_DATE_FIELDS = ("breach_date", "breachdate", "date")

# docs/search, "Error Messages". Curated so an upstream code becomes a sentence
# written here, never text passed through from the response.
_ERROR_CODE_NOTES = {
    "MISSING SEARCH TYPE": "Leak-Lookup rejected the request (missing search type).",
    "MISSING SEARCH QUERY": "Leak-Lookup rejected the request (missing search query).",
    "MISSING API KEY": "Leak-Lookup rejected the request: API key was not accepted as present.",
    "MISSING REQUIRED PARAMETERS": "Leak-Lookup rejected the request (missing required parameters).",
    "EMPTY VALUE DETECTED": "Leak-Lookup rejected the request (empty parameter).",
    "SEARCH FAILED": "Leak-Lookup search failed upstream — retry later.",
    "SEARCH QUERY BLACKLISTED": (
        "Leak-Lookup has blacklisted this query type; the domain type is partly "
        "blacklisted for abuse (docs/search)."
    ),
    "REQUEST LIMIT REACHED": (
        "Leak-Lookup daily request limit reached (public key: 10 requests/day). "
        "Rate limiting — retry after the allowance resets."
    ),
    "RATE LIMIT REACHED": (
        "Leak-Lookup rate limiting: more than 5 requests in the last minute. "
        "Rate limiting — wait a minute before retrying."
    ),
    "INACTIVE API KEY": "The configured Leak-Lookup API key is inactive — renew it.",
    "INVALID API KEY": "The configured Leak-Lookup API key is invalid.",
}
_RATE_LIMIT_CODES = {"REQUEST LIMIT REACHED", "RATE LIMIT REACHED"}


def _clean(value: Any, limit: int) -> str | None:
    """Strip escapes/control characters, collapse whitespace, clip. Never raises.

    ANSI first, then control characters. Deleting the ESC byte on its own would
    leave the literal "[31m" glued onto the name and make it look like a
    different breach, which is the reason app/services/phone_lookup_service.py
    orders it this way too.
    """
    if not isinstance(value, str):
        return None
    text = _CONTROL_RE.sub("", _ANSI_RE.sub("", value))
    text = " ".join(text.split())
    return text[:limit] or None


def _scrub(text: str) -> str:
    """Make an upstream error string safe to show a user.

    Redacts `key=…` exactly as orchestrator.sanitize_error does, then an
    email-shaped address, then any `field=value` pair naming something
    credential-shaped, then clips. The last rule exists because an upstream
    error is free to echo the row it choked on: a message reading
    `password=b4b9b02e...` would otherwise put a leaked credential hash into a
    note that is persisted to `scans.result_snapshot` and rendered in history.

    Pattern-based redaction cannot be complete — a bare hash with no field name
    is indistinguishable from ordinary text. The primary guarantee is therefore
    still structural: credential row data never reaches this function at all.
    This is the second layer, for the case where upstream puts it in an error
    string instead of a row.
    """
    out = _KEY_QUERY_RE.sub(r"\1…", text)
    out = _KEY_BARE_RE.sub("key=…", out)
    out = _SECRET_ASSIGN_RE.sub(r"\1=[redacted]", out)
    out = _EMAIL_RE.sub("[redacted]", out)
    return out[:MAX_NOTE_CHARS]


def _note(text: str) -> str:
    """Bound every note so nothing unbounded reaches the client or the cache."""
    return _scrub(text)[:MAX_NOTE_CHARS]


def _result(
    status: str,
    count: int,
    findings: list[dict[str, Any]],
    truncated: bool,
    note: str,
) -> dict[str, Any]:
    """Build the shared history-source contract. Exactly these seven keys."""
    return {
        "source": SOURCE,
        "status": status,
        "count": count,
        "findings": findings,
        "truncated": truncated,
        "note": _note(note),
    }


def _unavailable(note: str) -> dict[str, Any]:
    return _result("unavailable", 0, [], False, note)


def _looks_like_ip(value: str) -> bool:
    try:
        ipaddress.ip_address(value)
        return True
    except ValueError:
        return False


def _normalize_target(target: Any) -> str:
    """Normalise and bound the target. Returns "" when it is not a target at all.

    Deliberately does NOT validate hostname labels, so that the caller can
    distinguish "this is an address / a free-text paste, refused" from "this is a
    private address, refused" — `localhost` is the case that separates them.

    Never echoes the target back into a note: if a caller passes an address
    where a hostname was expected, the refusal must not itself be the leak.
    """
    if not isinstance(target, str):
        return ""
    value = target.strip().lower().removeprefix("*.").rstrip(".")
    if not value or "@" in value:
        # `@` is never in a hostname. It is the signature of an email address,
        # and this module does not look up individuals — see the docstring.
        return ""
    return value[:MAX_QUERY_CHARS]


def _is_queryable(value: str) -> bool:
    """True for a public IP literal, or a hostname of two or more sound labels.

    The two-label rule is a budget decision as much as a validation one: the
    public key allows 10 requests/day, and a single-label query cannot name a
    registrable domain, so spending an allowance on it buys nothing.
    """
    if _looks_like_ip(value):
        return True
    labels = value.split(".")
    return len(labels) >= 2 and all(_LABEL_RE.fullmatch(label) for label in labels)


def _is_error_flag(value: Any) -> bool:
    """Read Leak-Lookup's `error` field.

    The documented payload spells the flag as the STRING "false" ("error":
    "false"), which is truthy in Python. A plain `if payload.get("error")` would
    therefore report success as failure on every successful response, so the
    string form is compared explicitly.
    """
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"true", "1", "yes", "error"}
    if isinstance(value, (int, float)):
        return bool(value)
    return False


def _error_note(message: Any, status: str) -> str:
    """Map an upstream error code to a sentence written here."""
    code = message.strip().upper() if isinstance(message, str) else ""
    curated = _ERROR_CODE_NOTES.get(code)
    if curated:
        return curated
    detail = _scrub(str(message)) if message not in (None, "") else ""
    return (
        f"Leak-Lookup reported an error ({status}): {detail}"
        if detail
        else (f"Leak-Lookup reported an error ({status}).")
    )


def _breach_date(rows: Any) -> str | None:
    """Best-effort breach date from the FIRST row only.

    Reads exactly one element and returns. A private-key response can carry
    10,000 rows per breach; walking them to find a date would mean touching
    every credential record for a cosmetic field that the API does not even
    document. `matches` comes from `len()`, which never materialises a row.
    """
    if not isinstance(rows, list) or not rows:
        return None
    first = rows[0]
    if not isinstance(first, dict):
        return None
    for field in _DATE_FIELDS:
        found = _clean(first.get(field), MAX_DATE_CHARS)
        if found:
            return found
    return None


def _aggregate(message: dict[Any, Any]) -> tuple[int, list[dict[str, Any]], bool]:
    """Turn the per-breach row lists into counts. Never returns row data.

    `matches` is None wherever the count is not knowable — which, per
    docs/search, is every breach name under a public API key, where the value is
    an empty array because the columns were stripped. An empty list is treated
    as "unknown" rather than "zero" for exactly that reason: a private-key
    response only lists breach names that matched, so an empty array under a
    private key is not an expected shape.

    `count` is summed over EVERY breach, not just the MAX_FINDINGS that get
    emitted. `len()` on a list never materialises a row, so the extra pass costs
    nothing, and truncating the exposure number to fit the render budget would
    understate it — the wrong direction for a security figure.
    """
    items = list(message.items())
    truncated = len(items) > MAX_FINDINGS

    total = 0
    for _, rows in items:
        if isinstance(rows, list) and rows:
            total += len(rows)

    findings: list[dict[str, Any]] = []
    for raw_name, rows in items[:MAX_FINDINGS]:
        name = _clean(raw_name, MAX_NAME_CHARS)
        if not name:
            # An unusable key is skipped rather than echoed: the key is
            # attacker-influenced and must not become a row unfiltered.
            continue
        matches = len(rows) if isinstance(rows, list) and rows else None
        findings.append(
            {
                "name": name,
                "date": _breach_date(rows),
                "matches": matches,
            }
        )
    return total, findings, truncated


def _ok_note(total: int, findings: list[dict[str, Any]], countable: bool) -> str:
    breaches = len(findings)
    if not findings:
        return (
            "No indexed leaks found for this target. Leak-Lookup does not validate "
            "its data, so this is absence from its index, not proof of no exposure."
        )
    privacy = (
        "Counts only: email addresses, usernames, passwords, hashes and salts are "
        "fetched transiently and discarded, and are never returned, logged or stored."
    )
    if not countable:
        return (
            f"{breaches} breach name(s) matched, but the configured public API key "
            "returns breach names only, so per-breach match counts are not "
            "disclosed. count=0 here means NOT COUNTABLE, not clean. " + privacy
        )
    return (
        f"{total} leaked credential record(s) across {breaches} breach name(s). "
        "A record count is not a count of distinct people. " + privacy
    )


async def lookup(
    target: str, client: httpx.AsyncClient | None = None
) -> dict[str, Any]:
    """Return aggregate breach-exposure counts for one domain or IP.

    Args:
        target: a hostname or a public IPv4/IPv6 literal. `*.` prefixes and
            trailing dots are normalised away and the value is clipped to 253
            characters. An email address, a private address and localhost are
            all refused without any request being sent.
        client: optional shared `httpx.AsyncClient`. When None a private
            client is created and closed here. `User-Agent` is set on the
            request either way, so it is sent even for a caller-supplied client.

    Returns:
        The shared history-source contract, exactly:
        `{"source", "status", "count", "findings", "truncated", "note"}`.
        `status` is one of "ok", "unavailable", "not_configured". `count` is the
        number of leaked credential records observed, summed from `len()` of
        each breach's row list; it is 0 and honestly labelled "not countable"
        on a public API key, because the response shape does not disclose it.
        Each finding is `{"name", "date", "matches"}` where `matches` is an int
        or None for "not disclosed by this key tier". `truncated` is True when
        more than MAX_FINDINGS breach names were returned.

    Never raises. Every failure is an `unavailable` (or `not_configured`)
    result with a sanitised note, so a breach source can only ever degrade a
    scan into a partial result.

    Raises:
        Nothing, by design. Type errors in `target` are reported as an
        `unavailable` result rather than an exception.
    """
    api_key = _api_key()
    if not api_key:
        # docs/search: "The leak-lookup API requires an API key to perform
        # queries." There is no keyless endpoint, so this is a configuration
        # state, not a failure — and no request is spent discovering it.
        return _result(
            "not_configured",
            0,
            [],
            False,
            "LEAKLOOKUP_API_KEY is not set. Leak-Lookup requires a key for every "
            "search; the free public tier is limited to 10 requests/day.",
        )

    query = _normalize_target(target)
    if not query:
        return _unavailable(
            "Target is not a domain or IP address. This module does not look up "
            "individuals: the email, username, phone and fullname search types are "
            "deliberately not wired up."
        )
    if is_blocked_target(query):
        # Checked before label validation so `localhost` reports the reason that
        # actually applies to it rather than "not a domain".
        return _unavailable(
            "Target is a private, loopback or link-local address — not sent to "
            "Leak-Lookup."
        )
    if not _is_queryable(query):
        return _unavailable(
            "Target is not a valid domain name or IP address, so no query was "
            "spent on it."
        )

    search_type = "ipaddress" if _looks_like_ip(query) else "domain"

    own = client is None
    if own:
        client = httpx.AsyncClient(headers={"User-Agent": USER_AGENT})
    timeout = _timeout_seconds()

    try:
        try:
            response = await client.post(
                API_URL,
                # The key goes in the FORM BODY, never in the query string, so it
                # cannot end up in a logged URL or in an httpx exception message.
                data={"key": api_key, "type": search_type, "query": query},
                headers={"User-Agent": USER_AGENT},
                timeout=timeout,
            )
        except (httpx.TimeoutException, TimeoutError):
            return _unavailable(
                f"Leak-Lookup timed out after {timeout:g}s. Rate limiting is also "
                "plausible on this tier — retry later."
            )
        except httpx.HTTPError as exc:
            # Type name only: an httpx message can embed the request URL, and
            # the safest thing to do with an upstream transport error is to say
            # what failed and nothing about how.
            return _unavailable(
                f"Leak-Lookup request failed ({_scrub(type(exc).__name__)})."
            )

        status_code = response.status_code

        if status_code == 429:
            # No retry, deliberately: the public tier is 10 requests/day and a
            # retry loop against a documented daily cap is how a key gets
            # terminated under the ToS.
            return _unavailable(
                "Leak-Lookup rate limiting (HTTP 429) — the daily or per-minute "
                "allowance is exhausted. Rate limited; retry after the allowance "
                "resets."
            )
        if status_code >= 400:
            return _unavailable(f"Leak-Lookup lookup failed (HTTP {status_code}).")

        try:
            payload = response.json()
        except ValueError:
            return _unavailable("Leak-Lookup returned a response that was not JSON.")
        if not isinstance(payload, dict):
            return _unavailable("Leak-Lookup returned an unrecognised response shape.")

        if _is_error_flag(payload.get("error")):
            # On an error, `message` is the documented short code as a string.
            note = _error_note(payload.get("message"), f"error {status_code}")
            return _unavailable(note)

        message = payload.get("message")
        if not isinstance(message, dict):
            return _unavailable("Leak-Lookup returned an unrecognised response shape.")

        total, findings, truncated = _aggregate(message)
        countable = any(f["matches"] is not None for f in findings)
        return _result(
            "ok",
            total,
            findings,
            truncated,
            _ok_note(total, findings, countable),
        )
    finally:
        if own and client is not None:
            await client.aclose()
