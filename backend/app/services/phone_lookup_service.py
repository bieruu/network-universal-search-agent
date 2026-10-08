"""Phone number format/country validation — fully offline, deliberately small.

WHAT THIS IS
    Parse a phone number with libphonenumber's bundled ITU metadata, then
    report how well-formed it is and which country its prefix belongs to.
    No network, no database, no cache, no persistence: `phonenumbers` is a pure
    local library, so this module is SYNCHRONOUS on purpose. Wrapping a local
    parse of a short string in `async`/`asyncio.to_thread` would buy nothing and
    only hide that the work is cheap.

WHAT THIS IS NOT — AND WHY
    Carrier lookup, line-type lookup (mobile/landline/toll-free/VOIP) and owner
    or reverse-directory lookup are NOT included. libphonenumber is a *format*
    library: `is_valid_number()` answers "is this well-formed for that country",
    never "does this number exist, is it in use, or who has it". Answering the
    second question needs a paid HLR/number-portability data source (numverify,
    AbstractAPI, Twilio Lookup, ...), i.e. another API key and another vendor.
    Rather than ship a half-built integration behind a config knob that nobody
    has paid for, the capability is omitted entirely and the returned `note`
    says so on every result. Honesty over appearance.

    Consequently: **never** present a `valid: true` result as evidence that a
    number is real, reachable, or attributable to a person. It is evidence of
    well-formedness and nothing else.

ERROR CONTRACT (documented because callers must branch on it)
    - `number` not a `str`                  -> TypeError
    - `region` not a `str`                 -> TypeError
    - `region` not exactly two ASCII
      letters, or not a region libphonenumber supports -> ValueError
    - `number` is a `str` with no ASCII digits at all, i.e. not even a
      plausible phone string ("", "abc", "n/a")  -> ValueError
    - every other input, including anything malformed, out-of-range or
      unparseable, RETURNS a dict with `valid: False` and an explanatory
      `note`. It never raises, so a router can never turn bad input into a 500.
"""

from __future__ import annotations

import re
from typing import Any

import phonenumbers
from phonenumbers import PhoneNumberFormat, geocoder

# Matches what the UI renders in the "source" column, so a result is
# self-labelling as offline in history/export without the router adding it.
SOURCE = "Phone validation (offline)"

# Every user-controlled string is bounded before it is echoed back: this output
# is persisted into scans.result_snapshot and rendered in tables, so an
# unbounded echo is a payload-growth vector as much as a layout problem.
MAX_INPUT_CHARS = 64
MAX_FORMATTED_CHARS = 64
MAX_GEO_CHARS = 100
MAX_NOTE_CHARS = 300

# Hard cap on one bulk request, matching the repo's <=100-match rule elsewhere.
# Bulk parsing is CPU-cheap, but an unbounded list is still an unbounded render
# and an unbounded result_snapshot row.
MAX_BULK = 100

# C0/C1 control characters and DEL. Stripped before parsing so a pasted value
# cannot smuggle terminal escapes into history rows or logs.
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]")
# Colour/cursor escapes (CSI and Fe sequences) first: pasting from a terminal
# leaves "\x1b[31m" in the buffer, and simply deleting the ESC byte would leave
# the literal text "[31m" glued into the number and make a real number look
# invalid. Stripping the whole sequence keeps the verdict honest.
_ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]")
_WHITESPACE_RE = re.compile(r"\s+")
_REGION_RE = re.compile(r"[A-Z]{2}")
_ASCII_DIGIT_RE = re.compile(r"[0-9]")

# The library's helpers raise a mix of exception types depending on input and
# on version: NumberParseException, unicode errors from formatting, and plain
# ValueError/TypeError from its own validation. Each guard below degrades ONE
# field to None rather than failing the request, so the set is spelled out
# instead of a blind `except Exception` (which would also swallow a genuine bug
# like a typo'd attribute name).
_FIELD_ERRORS = (
    phonenumbers.NumberParseException,
    UnicodeError,
    ValueError,
    TypeError,
    AttributeError,
)

# One sentence on every result, per the "what we do not know" rule above. Kept
# separate so it cannot drift between the valid and invalid paths.
_CARRIER_DISCLAIMER = (
    "Carrier and line-type lookup are not included (they need a paid data source)."
)


def _clean(value: str) -> str:
    """Strip escapes/control characters and collapse whitespace. Never raises.

    Control characters are *deleted* rather than replaced with a space: a stray
    byte in the middle of a number must not invent a digit group that changes
    the parse.
    """
    return _WHITESPACE_RE.sub(" ", _CONTROL_RE.sub("", _ANSI_RE.sub("", value))).strip()


def _truncate(value: str | None, limit: int) -> str | None:
    """Clip to `limit` and turn the empty result into None."""
    if value is None:
        return None
    out = _clean(str(value))[:limit]
    return out or None


def _note(text: str, truncated_input: bool = False) -> str:
    """Assemble the always-present caveat tail and bound the result."""
    note = text
    if truncated_input:
        note += f" Input was truncated to {MAX_INPUT_CHARS} characters."
    return note[:MAX_NOTE_CHARS]


def _resolve_region(region: str | None) -> str | None:
    """Validate the caller's default region, returning it upper-cased.

    Rejects rather than guessing: a silently ignored typo here would parse a
    national-format number against the wrong country and report a confident
    "valid" for the wrong region, which is exactly the kind of overreach this
    module exists to avoid.
    """
    if region is None:
        return None
    if not isinstance(region, str):
        raise TypeError("region must be a string ISO 3166-1 alpha-2 code or None")
    code = _clean(region).upper()
    if not _REGION_RE.fullmatch(code):
        raise ValueError(
            "region must be exactly two ASCII letters (ISO 3166-1 alpha-2, e.g. 'US')"
        )
    # Non-geographical calling codes (e.g. '001') are absent from
    # SUPPORTED_REGIONS, so they are rejected here for free.
    if code not in phonenumbers.SUPPORTED_REGIONS:
        raise ValueError(f"region {code!r} is not a region libphonenumber supports")
    return code


def _format(number: Any, fmt: PhoneNumberFormat) -> str | None:
    """format_number, guarded. Returns None instead of propagating."""
    try:
        return _truncate(phonenumbers.format_number(number, fmt), MAX_FORMATTED_CHARS)
    except _FIELD_ERRORS:
        # phonenumbers.format_number raises on some inputs the parse stage let
        # through. A formatting failure must degrade one field to None, never
        # the whole request.
        return None


def _country_name(number: Any) -> str | None:
    """English country name for the number's region, or None if unknown."""
    try:
        return _truncate(geocoder.country_name_for_number(number, "en"), MAX_GEO_CHARS)
    except _FIELD_ERRORS:
        return None


def _area_description(number: Any) -> str | None:
    """Geocoder area text (e.g. 'San Francisco, CA'), or None if unknown.

    This is prefix/area-code geography from bundled metadata — not a location
    for the handset and not a subscriber address.
    """
    try:
        return _truncate(geocoder.description_for_number(number, "en"), MAX_GEO_CHARS)
    except _FIELD_ERRORS:
        return None


def _region_for(number: Any) -> str | None:
    """ISO alpha-2 for the parsed number, or None if the prefix resolves nowhere."""
    try:
        code = phonenumbers.region_code_for_number(number)
    except _FIELD_ERRORS:
        return None
    return code if isinstance(code, str) and len(code) == 2 else None


def _parse_notes(error_type: int) -> str:
    """Human-readable reason a string could not be parsed at all.

    NumberParseException.error_type is a small documented enum; mapping the
    cases the UI can act on beats surfacing "(0) Missing or invalid default
    region." to a user.
    """
    npe = phonenumbers.NumberParseException
    reasons = {
        npe.INVALID_COUNTRY_CODE: (
            "No country could be determined and no default region was supplied. "
            "Use international format (leading +) or pass a region such as 'US'."
        ),
        npe.NOT_A_NUMBER: (
            "Not interpretable as a phone number. Use international format "
            "(leading +), or pass a region such as 'US' for national-format input."
        ),
        npe.TOO_SHORT_AFTER_IDD: (
            "Too few digits after the country code to be any real number."
        ),
        npe.TOO_SHORT_NSN: (
            "Too few digits to be any real number. Check the number for dropped digits."
        ),
        npe.TOO_LONG: (
            "More digits than any real number has. Check the number for extra digits."
        ),
    }
    return reasons.get(
        error_type,
        "Not interpretable as a phone number. Use international format (leading +).",
    )


def _empty_result(cleaned: str) -> dict[str, Any]:
    """The all-unknown result used when nothing could be parsed at all."""
    return {
        "source": SOURCE,
        "input": cleaned,
        "valid": False,
        "possible": False,
        "e164": None,
        "national_format": None,
        "international_format": None,
        "country_code": None,
        "region": None,
        "country": None,
        "area_description": None,
        "note": "",
    }


def lookup(number: str, region: str | None = None) -> dict[str, Any]:
    """Validate one phone number offline and describe what is actually known.

    Args:
        number: the number as the user typed it. International format (leading
            `+`) is preferred; national format is accepted only when `region`
            supplies the default country. Control characters are stripped and
            the value is clipped to MAX_INPUT_CHARS before parsing.
        region: optional ISO 3166-1 alpha-2 default region (e.g. "ID", "US").
            `None` (the default) means international format is required.

    Returns:
        A JSON-serialisable dict — see the module docstring for the exact
        contract. `valid` and `possible` are deliberately separate fields:
        `possible` only means the length could fit a real number for that
        country, `valid` means it matches a real numbering pattern. Collapsing
        them is how a dashboard ends up claiming more than it knows. The
        format strings (e164/national/international) are withheld unless
        `valid` is True: handing back a copy-pasteable E.164 for a number this
        function just called invalid is a footgun. The prefix-derived
        `country_code`/`region`/`country` are still reported when the country
        calling code resolves, because a prefix is a fact about formatting and
        not a claim about the number.

    Raises:
        TypeError: `number` or `region` is not a `str`/`None`.
        ValueError: `region` is not two ASCII letters or is not a supported
            region, or `number` contains no ASCII digits at all. Anything
            malformed-but-digit-bearing returns `valid: False` instead.
    """
    if not isinstance(number, str):
        raise TypeError(f"number must be a string, got {type(number).__name__}")
    default_region = _resolve_region(region)

    raw = _clean(number)
    truncated = len(raw) > MAX_INPUT_CHARS
    cleaned = raw[:MAX_INPUT_CHARS]

    result = _empty_result(cleaned)
    if not _ASCII_DIGIT_RE.search(cleaned):
        # Not a phone string at all — a programming/UX error worth surfacing as
        # a 422 rather than dressing up as "an invalid phone number".
        raise ValueError(
            "number must contain at least one digit "
            f"(got {_truncate(cleaned, MAX_INPUT_CHARS)!r})"
        )

    try:
        parsed = phonenumbers.parse(cleaned, default_region)
    except phonenumbers.NumberParseException as exc:
        result["note"] = _note(
            f"{_parse_notes(exc.error_type)} {_CARRIER_DISCLAIMER}", truncated
        )
        return result
    except _FIELD_ERRORS:
        # Defensive only: a str input has not been observed to raise anything
        # beyond NumberParseException, and a 500 from a validator is worse than
        # a wrong-but-typed note.
        result["note"] = _note(
            f"Could not be parsed as a phone number. {_CARRIER_DISCLAIMER}",
            truncated,
        )
        return result

    valid = bool(phonenumbers.is_valid_number(parsed))
    possible = bool(phonenumbers.is_possible_number(parsed))

    region_code = _region_for(parsed)
    country = _country_name(parsed)
    result.update(
        {
            "valid": valid,
            "possible": possible,
            "country_code": getattr(parsed, "country_code", None),
            "region": region_code,
            "country": country,
            "area_description": _area_description(parsed),
        }
    )

    if valid:
        # Format strings only on a valid number — see the docstring.
        result["e164"] = _format(parsed, PhoneNumberFormat.E164)
        result["national_format"] = _format(parsed, PhoneNumberFormat.NATIONAL)
        result["international_format"] = _format(
            parsed, PhoneNumberFormat.INTERNATIONAL
        )
        where = country or region_code or "the detected country"
        result["note"] = _note(
            f"Format-valid for +{result['country_code']} ({where}). Well-formed for "
            "that country ONLY: this does NOT confirm the number exists, is in use, "
            f"or belongs to a named person. {_CARRIER_DISCLAIMER}",
            truncated,
        )
    else:
        where = country or region_code or "the detected country"
        lead = (
            f"Not a valid number for +{result['country_code']} ({where}). "
            if result["country_code"] is not None
            else "Not a valid number for the detected country prefix. "
        )
        result["note"] = _note(
            f"{lead}possible=True only means its length could fit a real number. "
            f"{_CARRIER_DISCLAIMER}",
            truncated,
        )
    return result


def lookup_many(numbers: list[str], region: str | None = None) -> dict[str, Any]:
    """Validate up to MAX_BULK numbers at once, each via `lookup()`.

    Bulk exists because the UI lets a user paste a list, and one rejected line
    must not lose the other 99 results — so per-item ValueError/TypeError is
    captured into that item's result dict (with `valid: False` and a note that
    says it was rejected before parsing) rather than failing the whole call.

    Input beyond the cap is dropped, not rejected, and reported through
    `counts_truncated` so the UI can say "showing 100 of 150" instead of
    silently under-reporting.
    """
    if isinstance(numbers, (str, bytes)):
        raise TypeError(
            "lookup_many() expects a list of strings; use lookup() for a single number"
        )
    try:
        items = list(numbers)
    except TypeError as exc:
        raise TypeError("lookup_many() expects a list of strings") from exc

    # Validate the region once, up front, so a bad region fails fast even when
    # every item would have been rejected anyway.
    _resolve_region(region)

    truncated = len(items) > MAX_BULK
    results: list[dict[str, Any]] = []
    for item in items[:MAX_BULK]:
        try:
            results.append(lookup(item, region))
        except (TypeError, ValueError) as exc:
            echo = _truncate(str(item), MAX_INPUT_CHARS) or ""
            stub = _empty_result(echo)
            stub["note"] = _note(
                f"Rejected before parsing ({type(exc).__name__}: {exc}). "
                f"{_CARRIER_DISCLAIMER}",
                len(str(item)) > MAX_INPUT_CHARS,
            )
            results.append(stub)

    valid_count = sum(1 for r in results if r["valid"])
    return {
        "source": SOURCE,
        "count": len(results),
        "submitted": len(items),
        "counts_truncated": truncated,
        "valid_count": valid_count,
        "possible_count": sum(1 for r in results if r["possible"]),
        "results": results,
        "note": (
            f"Format validation only for up to {MAX_BULK} numbers per call; "
            f"{valid_count} of {len(results)} returned are format-valid. "
            f"{_CARRIER_DISCLAIMER}"
        ),
    }
