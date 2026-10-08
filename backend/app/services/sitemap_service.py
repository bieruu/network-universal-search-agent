"""Sitemap read + internal/external URL classification. One fetch, one pass.

This is the one module in the repo whose *input is a document*, not a set of
records, so the interesting part is not the enumeration — it is refusing to be
tricked by the document. A sitemap is served by an attacker-chosen host, and
XML is the one format where "parse it" has historically meant "read my disk".

Two things make that safe here, and the tests prove both.

1. **A DOCTYPE is rejected before any parser sees the bytes.** The internal DTD
   subset is only legal *before* the root element, so it has to live in the
   prolog; we scan a generous 8 KiB of it for `<!DOCTYPE` / `<!ENTITY` and
   refuse the document outright. This is the primary guard, and it is a
   deliberate choice over the alternatives:

   - `lxml` / `defusedxml` would give a `resolve_entities=False` switch, but
     AGENTS.md §2 forbids new packages without approval, and a hardening switch
     is a *default* that a later edit can silently flip. Refusing the input is
     not a default anyone can relax.
   - A pure "ElementTree is safe" argument would be wrong. ElementTree does
     refuse external entities (see 2), but expat happily *expands internal*
     entities declared in the internal subset — a billion-laughs payload is
     parsed, not rejected. The prolog scan is what actually kills it.

2. **ElementTree is the backstop for anything that slips past the scan.** It has
   no external-entity resolution at all: `ET.fromstring` on an XXE payload raises
   `ParseError: undefined entity` and never touches the filesystem. That is a
   property of the stdlib parser, not a setting we chose, so it still holds if
   the scan window is ever widened by mistake. Modern expat also enforces its own
   input-amplification ceiling, but that is a version-dependent backstop, not
   something this module relies on.

Memory is bounded on top of that: the fetch cap (`settings.fetch_max_bytes`, 1 MiB
via `SafeFetcher`) bounds the body, we only ever *parse* the first
`_MAX_PARSE_BYTES`, and only `_MAX_URLS` URLs survive the pass.

What this deliberately does NOT do: recurse into `<sitemapindex>` children, parse
robots.txt, crawl the listed pages, or issue per-URL requests. Each of those
turns one fetch into an unbounded crawl against a host we do not control
(AGENTS.md §7).
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from typing import Any
from urllib.parse import urlsplit

from app.core.ssrf import SafeFetcher, SsrfBlocked

SOURCE = "Sitemap"
# Matches the AGENTS.md §4 external-string limit used by the other services.
MAX_URL_LENGTH = 2048
# Hard ceiling on the URL list. A 50k-entry sitemap is a crawl, not a summary.
MAX_URLS = 500
# Only this much of the body is ever handed to the parser. The fetch cap already
# bounds the body at 1 MiB; this is the belt to that braces, for a caller that
# injects a `SafeFetcher(max_bytes=...)` of its own.
MAX_PARSE_BYTES = 2 * 1024 * 1024
# How much of the prolog is scanned for a DTD. 8 KiB is far more than the XML
# declaration, a namespace preamble and any plausible comment; anything larger
# belongs to the document body, where a DTD could not legally live anyway.
PROLOG_SCAN_BYTES = 8 * 1024

_URLSET = "urlset"
_SITEMAPINDEX = "sitemapindex"
_DROP_MARKERS = ("<!DOCTYPE", "<!ENTITY")


def _sitemap_url(url: str) -> str:
    """Derive `{origin}/sitemap.xml` from a page URL.

    Deliberately does *not* normalise a bare domain: the scan router owns target
    normalisation, and guessing here would mean two places deciding what "a
    target" is. A URL we cannot read an origin from is a fetch we cannot
    authorise, so it raises rather than guessing.
    """
    try:
        parts = urlsplit(url.strip())
        host = parts.hostname
        port = parts.port
    except ValueError as e:  # bad port / bad IPv6 literal
        raise SsrfBlocked("Malformed URL") from e

    scheme = parts.scheme.lower()
    if not scheme:
        # Almost always a bare domain, which is the router's job to normalise.
        # Saying so beats reporting a scheme error for a URL that has none.
        raise SsrfBlocked("URL has no scheme (expected a full http/https URL)")
    if scheme not in ("http", "https"):
        raise SsrfBlocked("Only http and https URLs can be fetched")
    if not host:
        raise SsrfBlocked("URL has no host")

    # `hostname` is already lowercased and has IPv6 brackets removed.
    authority = f"[{host}]" if ":" in host else host
    if port is not None:
        authority = f"{authority}:{port}"
    # Path, query, fragment and userinfo are all dropped: a sitemap lives at the
    # site root, and this is a fresh URL, not the caller's.
    return f"{scheme}://{authority}/sitemap.xml"


def _normalized_host(host: str) -> str:
    """Lowercase, drop the root label's trailing dot, and fold away `www.`.

    The `www.` fold matters because a sitemap mixes both spellings of the same
    site and treating them as two hosts would report the target's own pages as
    external.
    """
    host = host.strip().lower().rstrip(".")
    return host.removeprefix("www.")


def _is_internal(candidate: str, base: str) -> bool:
    """Same host or a subdomain of it. Anything else is external.

    The dot in `.{base}` is load-bearing: without it `notexample.com` would be
    internal to `example.com`.
    """
    return candidate == base or candidate.endswith(f".{base}")


def _looks_like_html(text: str) -> bool:
    """Cheap sniff so a soft-404 HTML page reads as 'not XML', not 'broken XML'.

    A 200 carrying `<!DOCTYPE html>` is the single most common real-world
    outcome for this fetch, and the note should say so.
    """
    head = text.lstrip("﻿ \t\r\n").lower()[:256]
    return head.startswith(("<!doctype html", "<html", "<head"))


def _local_name(tag: str) -> str:
    """Strip a `{namespace}` prefix so a namespaced and a bare doc behave alike."""
    if isinstance(tag, str) and tag.startswith("{"):
        tag = tag.split("}", 1)[1]
    return tag.lower()


def _parse_sitemap(text: str) -> tuple[ET.Element | None, str]:
    """Return `(root, note)`. `note` explains a refusal or is empty on success."""
    # Order matters here. An HTML page is not an XML document at all, so it is
    # diagnosed as "not XML" *before* the DTD scan runs — otherwise its innocent
    # `<!DOCTYPE html>` would be reported as a hostile DTD, which is both less
    # accurate and much more alarming than the truth.
    if not text.strip():
        return None, "sitemap response was empty"
    if _looks_like_html(text):
        return None, "sitemap response was not XML (looked like HTML)"

    head = text[:PROLOG_SCAN_BYTES].upper()
    if any(marker in head for marker in _DROP_MARKERS):
        return None, (
            "sitemap rejected: it declares a DOCTYPE/ENTITY, which is never parsed"
        )
    try:
        # The explicit parser is the single seam where any future hardening
        # goes; ElementTree has no `resolve_entities` switch to flip.
        root = ET.fromstring(text, parser=ET.XMLParser())
    except ET.ParseError as e:
        # Report the position, not the parser's message: the message quotes
        # bytes from a document an attacker wrote, and `notes` reaches the UI.
        line = e.position[0] if getattr(e, "position", None) else 0
        return None, f"sitemap XML was malformed (parse error on line {line})"
    return root, ""


def _locs(root: ET.Element) -> list[str]:
    """Every `<url><loc>` under `root`, in document order.

    Namespace-agnostic and tolerant of a missing namespace: real sitemaps omit
    `xmlns` surprisingly often.
    """
    out: list[str] = []
    for url_node in root:
        if _local_name(url_node.tag) != "url":
            continue
        for child in url_node:
            if _local_name(child.tag) == "loc":
                out.append("".join(child.itertext()).strip())
                break
    return out


def _build(
    sitemap_url: str | None,
    found: bool,
    urls: list[dict[str, str]],
    *,
    counts_truncated: bool,
    body_truncated: bool,
    notes: list[str],
) -> dict[str, Any]:
    return {
        "source": SOURCE,
        "sitemap_url": sitemap_url,
        "found": found,
        "urls": urls,
        # Counts describe the returned list, so they never disagree with it.
        "internal_count": sum(1 for u in urls if u["kind"] == "internal"),
        "external_count": sum(1 for u in urls if u["kind"] == "external"),
        "counts_truncated": counts_truncated,
        "truncated": body_truncated,
        "notes": notes,
    }


async def lookup(url: str, fetcher: SafeFetcher | None = None) -> dict[str, Any]:
    """Read `{origin}/sitemap.xml` and split its URLs into internal/external.

    `found: False` is the normal outcome for most of the internet — plenty of
    sites publish no sitemap — and is returned as a normal result with a note,
    never as an exception. SSRF policy failures (`SsrfBlocked`, `SsrfTimeout`,
    `SsrfTooManyRedirects`) and `httpx` errors deliberately propagate: they are
    the router's to turn into `errors[]`, and swallowing them here would report
    "no sitemap" for a request that was refused.
    """
    base = _normalized_host(urlsplit(url.strip()).hostname or "")
    sitemap_url = _sitemap_url(url)

    own_fetcher = fetcher is None
    if own_fetcher:
        fetcher = SafeFetcher()
    try:
        result = await fetcher.fetch(sitemap_url)
    finally:
        # Only a fetcher we built is ours to close; an injected one outlives us
        # and is closed by whoever created it.
        if own_fetcher:
            assert fetcher is not None
            await fetcher.aclose()

    body_truncated = result.truncated

    if result.status != 200:
        return _build(
            None,
            False,
            [],
            counts_truncated=False,
            body_truncated=body_truncated,
            notes=[f"no sitemap served at {sitemap_url} (HTTP {result.status})"],
        )

    root, parse_note = _parse_sitemap(result.text(MAX_PARSE_BYTES))
    if root is None:
        return _build(
            None,
            False,
            [],
            counts_truncated=False,
            body_truncated=body_truncated,
            notes=[parse_note],
        )

    # The guard reports the final URL in hostname form, so a redirect that moved
    # the sitemap somewhere else is visible here without leaking the IP pinning.
    final_url = result.final_url
    tag = _local_name(root.tag)

    if tag == _SITEMAPINDEX:
        # Found a sitemap, but it lists sitemaps rather than pages. Reporting the
        # child count and stopping is the honest answer; fetching them is an
        # open-ended crawl, which is explicitly out of scope.
        children = sum(1 for c in root if _local_name(c.tag) == "sitemap")
        return _build(
            final_url,
            True,
            [],
            counts_truncated=False,
            body_truncated=body_truncated,
            notes=[
                (
                    f"sitemap is a <sitemapindex> listing {children} child sitemaps; "
                    "nested sitemaps are not crawled"
                )
            ],
        )

    if tag != _URLSET:
        return _build(
            final_url,
            False,
            [],
            counts_truncated=False,
            body_truncated=body_truncated,
            notes=[f"no <urlset> found in sitemap (root was <{tag}>)"],
        )

    urls: list[dict[str, str]] = []
    seen: set[str] = set()
    counts_truncated = False

    for loc in _locs(root):
        candidate = loc[:MAX_URL_LENGTH]
        try:
            parts = urlsplit(candidate)
        except ValueError:
            continue
        scheme = parts.scheme.lower()
        if scheme not in ("http", "https") or not parts.hostname:
            # javascript:, data:, mailto:, and bare paths. Not crawlable and not
            # links in any sense the UI would render, so they are dropped rather
            # than reported as external.
            continue
        if candidate in seen:
            continue
        seen.add(candidate)
        if len(urls) >= MAX_URLS:
            counts_truncated = True
            break
        urls.append(
            {
                "url": candidate,
                "kind": (
                    "internal"
                    if _is_internal(_normalized_host(parts.hostname), base)
                    else "external"
                ),
            }
        )

    return _build(
        final_url,
        True,
        urls,
        counts_truncated=counts_truncated,
        body_truncated=body_truncated,
        notes=[],
    )
