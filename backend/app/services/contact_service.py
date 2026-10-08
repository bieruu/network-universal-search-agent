"""Contact extraction (email + phone) from one already-fetched page.

TODO.md v2: "Phone + email regex extraction from page source." This module is
the read; it is deliberately nothing else.

What it does
------------
One `GET` through the SSRF guard (`app/core/ssrf.py`), then a regex pass over
the decoded bytes looking for email addresses and phone numbers, plus the
addresses behind `mailto:` links.

What it deliberately does not do
--------------------------------
- **No verification, no enrichment.** No `phonenumbers`, no MX/DNS lookup, no
  carrier or line-type lookup, no third-party API of any kind. A read that
  turns into an outbound interaction with the target (or with a data broker
  about the people behind a number) is a different capability with different
  consent, so it needs its own service and its own rate-limit bucket — see the
  separate "Phone number lookup" TODO item. Everything returned here is a
  string that appeared in the page's own bytes.
- **No persistence.** No cache write, no DB write. The scan snapshot is the
  caller's job (AGENTS.md §7), and a contact list is the kind of thing that
  should not outlive the scan that produced it.
- **No HTML parsing.** Regex over raw text. A real parser would be a new
  dependency (AGENTS.md §2) to solve a problem regex solves well enough here,
  and every extracted value is untrusted, truncated, and rendered as plain text
  by the frontend anyway.

The 100-match cap
-----------------
`MAX_MATCHES` (100) is a **combined** budget across emails *and* phones, not a
per-list one. Two reasons:

1. The point of the cap is to bound how much address material one request can
   pull out of a page. A per-list cap bounds that at 200, which is twice the
   number the TODO authorised.
2. A per-list cap also makes the effective worst case depend on which list the
   attacker fills first, so the "≤100" promise would only hold for pages that
   happen to stay under both. One shared counter cannot be gamed by shaping the
   page.

Budget is spent in a fixed order: `mailto:` emails, then text emails, then
phones. That order is also the confidence order — an address in a `mailto:`
href was published as a contact, one sitting in body text may be a comment —
so when the budget runs out, what survives is the likeliest data. The visible
consequence is that an email-heavy page can starve `phones` completely; the
`note` says so rather than letting a caller assume both lists were exhausted.

Truncation and honesty
----------------------
The body is already capped by the SSRF guard (`settings.fetch_max_bytes`). When
that cap cut the body, `truncated` is true and the `note` says coverage is
partial — a page whose first 1 MiB happens to contain no contact address is
not a page with no contact address. Extraction still runs on what was
captured; it simply stops as soon as the match budget is spent.

Values are untrusted, so each is stripped of control/zero-width/bidi characters
and capped (`MAX_EMAIL_LEN` 254, `MAX_PHONE_LEN` 32). Note that clipping a
phone number produces a *different* phone number, so a clipped entry carries
`"truncated": true` and must not be displayed as if it were the number the page
published.

What this will get wrong
------------------------
A number printed with no separators is indistinguishable from any other 7-15
digit token in the text, so a long order number or a millisecond timestamp will
occasionally be reported as a phone. Rejecting every bare digit run would throw
away real contacts, because plenty of pages print `5550109999` unformatted, so
the noise is accepted and disclosed here instead: this is format extraction, not
validation. Deciding whether a number is real is what the separate phone-lookup
capability is for, and it needs its own bucket and its own data source.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Iterator
from typing import Any
from urllib.parse import unquote

from app.core.ssrf import FetchResult, SafeFetcher

log = logging.getLogger(__name__)

SOURCE = "Page contacts"

# Combined across emails and phones. See "The 100-match cap" in the docstring.
MAX_MATCHES = 100
MAX_EMAIL_LEN = 254
MAX_PHONE_LEN = 32

# Control chars (incl. C1), zero-width joiners/space, bidi overrides (a bidi
# override could visually reorder a phone number in the UI) and the BOM. \t, \n
# and \r go too: phones collapse whitespace anyway and an email containing one
# is not a real address.
_CONTROL_RE = re.compile("[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060\ufeff]")

# `mailto:` hrefs are the one place a page states an address as an address.
# The char class stops at `?` so `?subject=`/`?body=` cannot ride into the
# value, and at whitespace and the quote characters so the closing `"` or `>`
# of the attribute cannot either.
_MAILTO_RE = re.compile(r"mailto:([^\s\"'<>?]+)", re.IGNORECASE)

# RFC 5322 atext for the local part (quoted-string form not supported: a page
# that publishes `sales"@example.com` is not a lead), dot-atoms only, then a
# dotted domain whose last label is alphabetic. Requiring an alphabetic TLD is
# what keeps `x@2y`, `@2x` and version strings out without a junk list per
# shape.
_ATEXT = r"A-Za-z0-9!#$%&'*+/=?^_`{|}~\-"
_EMAIL_RE = re.compile(
    rf"(?<![{_ATEXT}.@-])"
    rf"[{_ATEXT}]+(?:\.[{_ATEXT}]+)*"
    r"@"
    r"(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+"
    r"[A-Za-z]{2,63}"
)

# Two phone patterns rather than one clever one:
#
#   * `_BARE_PHONE_RE` handles a number printed with no separators at all
#     (`5550109999`). Its separator-free lookbehind refuses to match inside an
#     already-formatted number, so it cannot emit the `010-9999` fragment of
#     `555-010-9999`.
#   * `_SEP_PHONE_RE` handles formatted numbers. Every group after the first
#     must start with a separator, which cannot be a digit, so the groups can
#     never ambiguously re-split one contiguous digit run. That is what keeps
#     this linear: there is no nested quantifier over overlapping classes, so a
#     hostile megabyte of digits costs time proportional to its length and not
#     exponentially more.
_PHONE_SEPARATORS = r" \t.\-\u2013\u2014"
_BARE_PHONE_RE = re.compile(r"(?<![0-9A-Za-z@._+\-])(?:\+)?\d{7,15}(?![0-9])")
_SEP_PHONE_RE = re.compile(
    r"(?<![0-9A-Za-z@._+\-])"
    r"(?:\+|00)?\(?\d{1,4}\)?"
    rf"(?:[{_PHONE_SEPARATORS}]{{1,3}}\(?\d{{2,6}}\)?){{1,4}}"
    r"(?![0-9A-Za-z])"
)
_PHONE_RES = (_SEP_PHONE_RE, _BARE_PHONE_RE)

_DIGITS_RE = re.compile(r"\D+")
_WHITESPACE_RE = re.compile(r"\s+")
_TRAILING_SEPARATORS = " \t.-\u2013\u2014"
# Nothing but a number and its separators may survive. Cheap belt-and-braces:
# it keeps a stray letter or tag from ever reaching the output even if a
# pattern is loosened later.
_PHONE_CHARS_RE = re.compile(r"^[+()\d \t.\-\u2013\u2014]+$")

# Shapes that survive the digit count but are not phone numbers.
_IPV4_RE = re.compile(r"^\d{1,3}[. ]\d{1,3}[. ]\d{1,3}[. ]\d{1,3}$")
_DATE_YMD_RE = re.compile(r"^\d{4}[-./]\d{1,2}[-./]\d{1,2}$")
_DATE_DMY_RE = re.compile(r"^\d{1,2}[-./]\d{1,2}[-./]\d{4}$")

# RFC 2606 / 6761 placeholders and asset extensions. These are the two shapes
# that account for nearly all false positives in real page source: an email
# inside an image filename (`logo@example.com.png`), and documentation
# addresses.
_RESERVED_DOMAINS = frozenset(
    {
        "example.com",
        "example.edu",
        "example.net",
        "example.org",
        "localhost",
    }
)
_RESERVED_SUFFIXES = (".example", ".invalid", ".localhost", ".local", ".test")
_ASSET_SUFFIXES = (
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".bmp",
    ".ico",
    ".tif",
    ".tiff",
    ".svg",
    ".css",
    ".js",
    ".mjs",
    ".map",
    ".woff",
    ".woff2",
    ".ttf",
    ".otf",
    ".eot",
    ".mp3",
    ".mp4",
    ".webm",
    ".avi",
    ".mov",
    ".pdf",
    ".zip",
    ".gz",
    ".tar",
    ".csv",
    ".json",
    ".xml",
    ".yaml",
    ".yml",
)

# Content types worth regexing. Anything else (a JPEG, a PDF) is binary that
# would only produce noise, and pretending otherwise would put garbage in front
# of a user as if it were a contact.
_TEXTUAL_MARKERS = (
    "json",
    "xml",
    "javascript",
    "xhtml",
    "x-www-form-urlencoded",
    "yaml",
)


def _clean_email(raw: str) -> str | None:
    """Return a normalised address, or None when it is not one.

    `fullmatch` on the whole candidate is the real validation: the search
    pattern is deliberately loose (it has to survive being embedded in
    arbitrary markup), so anything it matched is re-checked against the full
    RFC-ish shape before it is allowed to count as a lead.
    """
    value = _CONTROL_RE.sub("", raw).strip().strip("<>()[]{}\"'")
    value = value.rstrip(".,;:!?)")
    if not value or len(value) > MAX_EMAIL_LEN:
        return None
    if _EMAIL_RE.fullmatch(value) is None:
        return None

    local, _, domain = value.partition("@")
    lowered = domain.lower()
    if lowered in _RESERVED_DOMAINS or lowered.endswith(_RESERVED_SUFFIXES):
        return None
    if local.lower() in {"example", "your-email", "yourname"}:
        return None
    if lowered.endswith(_ASSET_SUFFIXES):
        return None
    # Defensive: validation above already rejects anything this long.
    return value[:MAX_EMAIL_LEN]


def _clean_phone(raw: str) -> dict[str, Any] | None:
    """Return a normalised phone entry, or None when it is not a number.

    The digit count is checked *after* clipping so a clipped value can never
    slip through as a short-but-valid number: a partial number is worse than no
    number, because it looks like one.
    """
    value = _WHITESPACE_RE.sub(" ", _CONTROL_RE.sub("", raw).strip())
    value = value.rstrip(_TRAILING_SEPARATORS)
    if not value or _PHONE_CHARS_RE.match(value) is None:
        return None

    clipped = len(value) > MAX_PHONE_LEN
    if clipped:
        value = value[:MAX_PHONE_LEN].rstrip(_TRAILING_SEPARATORS)

    digits = _DIGITS_RE.sub("", value)
    # E.164 is 15 digits including the country code, so 16+ is a document id,
    # an order number or a timestamp, and fewer than 7 cannot be dialled.
    if not 7 <= len(digits) <= 15:
        return None
    # A half-captured parenthesised group means the match was cut off by
    # markup (`(555<br>010-9999`) or by clipping. Dropping it beats showing a
    # number that was never on the page.
    if value.count("(") != value.count(")"):
        return None
    if _IPV4_RE.match(value) or _DATE_YMD_RE.match(value) or _DATE_DMY_RE.match(value):
        return None
    return {
        "value": value,
        "digits": digits,
        # Only what the page itself wrote: an explicit `+` or `00` prefix.
        # Inferring a region from the digits would be enrichment, which this
        # module does not do.
        "looks_international": value.startswith("+") or digits.startswith("00"),
        "truncated": clipped,
    }


def _candidates(text: str) -> Iterator[tuple[str, dict[str, Any]]]:
    """Yield `(kind, entry)` in budget order: mailto, text emails, phones.

    Entries are already validated and normalised, so the caller only has to
    dedupe and count them.
    """
    for match in _MAILTO_RE.finditer(text):
        # Percent-decoding is passive and local; anything it decodes to an
        # invalid address (a space, a newline) fails validation, which is what
        # stops `%0A` from smuggling a control character through.
        value = _clean_email(unquote(match.group(1)))
        if value is not None:
            yield "email", {"value": value, "source": "mailto"}
    for match in _EMAIL_RE.finditer(text):
        value = _clean_email(match.group(0))
        if value is not None:
            yield "email", {"value": value, "source": "text"}
    for pattern in _PHONE_RES:
        for match in pattern.finditer(text):
            entry = _clean_phone(match.group(0))
            if entry is not None:
                yield "phone", entry


def _is_textual(content_type: str) -> bool:
    if not content_type:
        return True
    if content_type.startswith("text/"):
        return True
    return any(marker in content_type for marker in _TEXTUAL_MARKERS)


def _summarize(result: FetchResult) -> dict[str, Any]:
    """Turn one fetched page into the reportable shape."""
    content_type = result.headers.get("content-type", "").split(";")[0].strip().lower()
    textual = _is_textual(content_type)

    emails: list[dict[str, Any]] = []
    phones: list[dict[str, Any]] = []
    seen_emails: set[str] = set()
    seen_phones: set[str] = set()
    counts_truncated = False

    if textual:
        # Strip control characters from the whole body first, not just from the
        # matches: a control character in the middle of a phone number would
        # otherwise cut the number in half and the remainder would look valid.
        text = _CONTROL_RE.sub("", result.text())
        for kind, entry in _candidates(text):
            if len(emails) + len(phones) >= MAX_MATCHES:
                counts_truncated = True
                break
            if kind == "email":
                key = str(entry["value"]).lower()
                if key in seen_emails:
                    continue
                seen_emails.add(key)
                emails.append(entry)
                continue
            if entry["digits"] in seen_phones:
                continue
            seen_phones.add(str(entry["digits"]))
            phones.append(entry)

    found = len(emails) + len(phones)
    log.debug(
        "contact_extract status=%s emails=%d phones=%d cap_hit=%s",
        result.status,
        len(emails),
        len(phones),
        counts_truncated,
    )

    notes = [
        (
            f"Hard cap of {MAX_MATCHES} matches total, emails and phones combined; "
            "nothing was verified, enriched or looked up anywhere."
        )
    ]
    if not textual:
        notes.append(
            f"Body was {content_type}, which is not text, so nothing was scanned."
        )
    if result.truncated:
        notes.append(
            "Only the first part of the body was captured before the fetch cap, "
            "so this is partial coverage — no match is not proof of none."
        )
    if counts_truncated:
        notes.append(
            f"Stopped at the {MAX_MATCHES}-match cap while scanning, in mailto, "
            "text-email then phone order, so a later list may be missing "
            "entirely."
        )
    if result.status >= 400:
        notes.append(f"The page answered HTTP {result.status}.")
    if textual and found == 0:
        notes.append("No email or phone pattern matched the page text.")

    return {
        "source": SOURCE,
        "url": result.final_url,
        "status": result.status,
        "emails": emails,
        "phones": phones,
        "match_cap": MAX_MATCHES,
        "counts_truncated": counts_truncated,
        "truncated": bool(result.truncated),
        "note": " ".join(notes),
    }


async def lookup(url: str, fetcher: SafeFetcher | None = None) -> dict[str, Any]:
    """Fetch `url` through the SSRF guard and report the contacts it published.

    `url` must already be a full http/https URL; normalising a bare domain is
    the router's job, because only the caller knows whether the user typed a
    domain or a path.

    A caller that already has a `SafeFetcher` (the orchestrator shares one
    client across sources) passes it in and keeps ownership of it. With no
    fetcher this builds and closes its own, in a `finally` so a blocked fetch
    cannot leak the client.

    Policy failures propagate: `SsrfBlocked`, `SsrfTimeout` and
    `SsrfTooManyRedirects` are decisions the caller must render, and httpx
    transport errors are its `errors[]` business. Swallowing them here would
    turn "the target was blocked" into "the target published no contacts".
    """
    owns_fetcher = fetcher is None
    if fetcher is None:
        fetcher = SafeFetcher()
    try:
        result = await fetcher.fetch(url)
        return _summarize(result)
    finally:
        if owns_fetcher:
            await fetcher.aclose()
