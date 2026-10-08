"""Response headers and `Set-Cookie` attributes from a single HTTP response.

Read-only observation of what a target already serves publicly: one fetch
through the SSRF guard, then the response is recorded and dropped. No body
parsing, no redirect chasing of our own, no grading — a security-header
score is a separate capability, and folding it in here would make this card
claim a judgement the module never made.

The one rule that is not negotiable is the `Set-Cookie` value. A cookie value
*is* a credential: it authenticates the browser holding it, so a scan snapshot
that stored one would hand a live session to whoever reads the row, and a UI
that rendered one would put a session token in the page (AGENTS.md §5/§7). So a
cookie is reported as its name and its attributes and the value never leaves
this function — not masked, not truncated, not present at all. Masking would
still be wrong: a masked prefix of a token is a prefix of a token, and the
length is itself information. `test_cookie_value_never_appears_in_the_result`
plants a secret and asserts `json.dumps` of the entire structure does not
contain it.

Two details of the guard make this module's parsing safe to write at all.
`FetchResult.headers` is `httpx.Headers` and keeps repeated names, so
`get_list("set-cookie")` sees every cookie rather than only the last one — the
one header that must never be collapsed. And response bytes arrive already
capped, so a hostile origin cannot stream indefinitely to make us parse.

Everything emitted is plain text and both lists are capped, so a target
cannot flood the card or smuggle markup into it. Truncation is always
reported in the output; nothing is dropped silently.

Network and policy failures are deliberately *not* handled here: `SsrfBlocked`,
`SsrfTooManyRedirects`, `SsrfTimeout` and `httpx.*` propagate to the caller,
which turns them into an `errors[]` entry on a 200 response. A blocked target
is a policy decision that must be visible, not an empty result that looks
like a target with no headers.
"""

from __future__ import annotations

from typing import Any

import httpx

from app.core.ssrf import SafeFetcher

# Caps. A hostile origin decides how many headers it sends and how long each
# one is, so both lists are bounded and every cut is reported in the output.
_MAX_HEADERS = 100
_MAX_COOKIES = 100
_MAX_HEADER_VALUE = 2048
_MAX_COOKIE_NAME = 256
_MAX_ATTR_VALUE = 1024
# Set-Cookie is parsed from a longer slice than anything we emit, so a padded
# attribute or a long Expires is not mangled by the emit cap. The slice still
# bounds the work: parsing must stay proportional to one header, not to
# whatever the origin put in it.
_MAX_COOKIE_PARSE = 16_384

# Stand-in for a value we refuse to emit. Not a mask: the credential is simply
# absent, and the cookie's name and attributes carry the whole observation.
_REDACTED = "[redacted]"

# Headers whose value is a credential and is therefore never emitted.
# Set-Cookie/Set-Cookie2 are why this module exists. The Authorization pair is
# here because a target that echoes a credential back must not be able to
# smuggle it out through this card (AGENTS.md §5: never return a secret to the
# client). `Set-Cookie2` is a deprecated alias that RFC 6265 removed, but a
# target sending it still set a cookie and silently dropping it would report a
# cookie surface that is not the real one.
_REDACTED_HEADERS = frozenset(
    {"set-cookie", "set-cookie2", "authorization", "proxy-authorization"}
)

# Cookie attributes we model. Anything outside this map is ignored rather than
# fatal — the attribute set is the origin's to extend, and an unknown one
# (Partitioned, Priority, an extension attribute) must not fail the parse.
_ATTR_FIELDS = {
    "domain": "domain",
    "path": "path",
    "samesite": "same_site",
    "expires": "expires",
    "max-age": "max_age",
}


def _split_cookie_parts(raw: str) -> list[str]:
    """Split a Set-Cookie value on `;`, ignoring separators inside quotes.

    A naive `split(";")` mangles `a="x;y"` and turns the tail of a quoted
    value into something that looks like an attribute. The input is attacker
    controlled, so the splitter is the tolerant one.
    """
    parts: list[str] = []
    current: list[str] = []
    quoted = False
    escaped = False

    for char in raw:
        if escaped:
            current.append(char)
            escaped = False
        elif quoted and char == "\\":
            current.append(char)
            escaped = True
        elif char == '"':
            quoted = not quoted
            current.append(char)
        elif char == ";" and not quoted:
            parts.append("".join(current))
            current = []
        else:
            current.append(char)

    parts.append("".join(current))
    return parts


def _sanitize(value: str, limit: int) -> str:
    """Bound a text value and strip quoting and control characters.

    Control characters go because this text is rendered by the dashboard and a
    header value is the origin's to choose: a raw ESC or newline is the raw
    material of a terminal/log escape injection once it lands in a rendered
    card. Space is kept — it is printable, and paths contain it.
    """
    value = value.strip()
    if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
        value = value[1:-1]
    return "".join(char for char in value if char.isprintable())[:limit]


def _parse_set_cookie(raw: str) -> dict[str, Any] | None:
    """Return one cookie's name and attributes, or None if it names nothing.

    The value half of `name=value` is never read into the result — dropping it
    is this function's entire reason to exist. A malformed cookie yields None
    (no name to show) or a record with empty attributes; it never raises,
    because a target sending garbage must degrade this card rather than fail
    the scan. `session=; Path=/` is a real cookie — a deletion — so an empty
    *value* is not a reason to skip anything.
    """
    parts = _split_cookie_parts(raw[:_MAX_COOKIE_PARSE])
    if not parts or "=" not in parts[0]:
        # `Set-Cookie: garbage` names no cookie. Showing a nameless row would
        # be a fabricated observation.
        return None

    name = parts[0].split("=", 1)[0].strip()
    if not name:
        return None

    cookie: dict[str, Any] = {
        "name": _sanitize(name, _MAX_COOKIE_NAME),
        "domain": None,
        "path": None,
        "secure": False,
        "http_only": False,
        "same_site": None,
        "expires": None,
        "max_age": None,
    }

    for part in parts[1:]:
        key, separator, value = part.partition("=")
        key = key.strip().lower()
        if not key:
            continue
        if key == "secure":
            cookie["secure"] = True
        elif key == "httponly":
            cookie["http_only"] = True
        elif not separator:
            # A valueless attribute we do not model. Ignored, not fatal.
            continue
        elif key in _ATTR_FIELDS:
            field = _ATTR_FIELDS[key]
            if cookie[field] is not None:
                continue  # Duplicate attribute: the first one wins.
            cookie[field] = _sanitize(value, _MAX_ATTR_VALUE)

    return cookie


def _cookie_headers(headers: httpx.Headers) -> list[str]:
    """Every `Set-Cookie` header, both spellings, none of them collapsed.

    `.get()` returns the repeats joined into one string, which would turn two
    cookies into one unparseable row. `get_list` is the only correct call here.
    """
    return [*headers.get_list("set-cookie"), *headers.get_list("set-cookie2")]


async def lookup(url: str, fetcher: SafeFetcher | None = None) -> dict[str, Any]:
    """Read one response's headers and its cookie names/attributes.

    `fetcher` is accepted so a caller can share one client across the
    capabilities that need it; an injected fetcher belongs to the caller and is
    never closed here. Without one, this function owns the fetcher for the
    length of the call and closes it either way — including when the fetch
    raises.

    `url` is a full http(s) URL. Normalising a bare domain to a URL is the
    router's job, so the guard, the cache key and the UI all agree on what was
    requested.
    """
    owns_fetcher = fetcher is None
    active = SafeFetcher() if fetcher is None else fetcher
    try:
        result = await active.fetch(url)
    finally:
        if owns_fetcher:
            await active.aclose()

    raw_cookies = _cookie_headers(result.headers)
    # One extra entry past the cap, so a list that is over the limit is still
    # detected without parsing a thousand headers an origin chose to send.
    parsed = [
        cookie
        for cookie in (
            _parse_set_cookie(raw) for raw in raw_cookies[: _MAX_COOKIES + 1]
        )
        if cookie is not None
    ]
    cookies = parsed[:_MAX_COOKIES]

    # multi_items(), not dict(multi_items()): repeats are real headers. They
    # are kept as list entries, which is also what lets a redacted Set-Cookie
    # appear once per cookie instead of vanishing into a merged value.
    pairs = list(result.headers.multi_items())
    headers = [
        {
            "name": name,
            "value": (
                _REDACTED
                if name.lower() in _REDACTED_HEADERS
                else _sanitize(value, _MAX_HEADER_VALUE)
            ),
        }
        for name, value in pairs[:_MAX_HEADERS]
    ]

    return {
        "source": "HTTP response",
        "url": result.final_url,
        "status": result.status,
        "truncated": result.truncated,
        "header_count": len(headers),
        "headers": headers,
        "headers_truncated": len(pairs) > _MAX_HEADERS,
        "cookie_count": len(cookies),
        "cookies": cookies,
        "cookies_truncated": len(raw_cookies) > _MAX_COOKIES,
    }
