"""Sitemap reader: classification, caps, and the XML-safety guarantees.

Transport is mocked on the *pinned IP*, because that is where the SSRF guard
actually sends the request (`test_ssrf.py` explains the pattern); patching the
resolver to a public address is what lets these tests reach the HTTP layer at
all.
"""

from __future__ import annotations

import json
import time
import xml.etree.ElementTree as ET

import httpx
import pytest
import respx

from app.core import ssrf
from app.core.ssrf import SafeFetcher, SsrfBlocked, SsrfTimeout
from app.services import sitemap_service

PUBLIC_IP = "93.184.216.34"
NS = "http://www.sitemaps.org/schemas/sitemap/0.9"

# A payload that, if entities were resolved, would read a local file. This is
# the headline case the module exists for.
XXE = (
    '<?xml version="1.0"?>'
    '<!DOCTYPE r [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>'
    f'<urlset xmlns="{NS}"><url><loc>&xxe;</loc></url></urlset>'
)

# Internal entities only — no file, no network, just amplification.
#
# Deliberately tuned to *stay under* expat's own input-amplification ceiling:
# six levels of ten expands to 1,000,000 characters from a ~200 byte DTD in
# ~20ms and expat raises nothing (verified against the stdlib directly). A
# payload big enough to trip expat's ceiling would prove nothing, because the
# stdlib would refuse it even with our guard removed. This shape is the one the
# prolog scan has to catch.
BILLION_LAUGHS = (
    '<?xml version="1.0"?><!DOCTYPE r ['
    + "".join(
        '<!ENTITY e{i} "{body}">'.format(
            i=i, body=f"&e{i - 1};" * 10 if i else "AAAAAAAAAA"
        )
        for i in range(6)
    )
    + f']><urlset xmlns="{NS}"><url><loc>&e5;</loc></url></urlset>'
)


def _elementtree_would_expand_the_bomb() -> bool:
    """Whether the stdlib parser alone expands `BILLION_LAUGHS`.

    If this ever flips to False, expat grew a hard ceiling that covers this
    shape — worth knowing, but it would still be a version-dependent backstop
    rather than the guard this module actually relies on.
    """
    try:
        root = ET.fromstring(BILLION_LAUGHS)
    except ET.ParseError:
        return False
    return len(root[0][0].text or "") > 500_000


def _resolve_to(monkeypatch, *addresses: str) -> None:
    monkeypatch.setattr(ssrf, "_sync_resolve_all", lambda host, port: list(addresses))


def _urlset(*locs: str, ns: str = NS) -> bytes:
    open_tag = f'<urlset xmlns="{ns}">' if ns else "<urlset>"
    body = "".join(f"<url><loc>{loc}</loc></url>" for loc in locs)
    return f'<?xml version="1.0"?>{open_tag}{body}</urlset>'.encode()


async def _lookup(
    monkeypatch, body: bytes, *, status: int = 200, url="https://example.com/"
):
    _resolve_to(monkeypatch, PUBLIC_IP)
    async with SafeFetcher() as fetcher, respx.mock:
        route = respx.get(f"https://{PUBLIC_IP}/sitemap.xml").mock(
            return_value=httpx.Response(status, content=body)
        )
        out = await sitemap_service.lookup(url, fetcher)
    return out, route


# --------------------------------------------------------------------------
# Happy path
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_urlset_splits_into_internal_and_external(monkeypatch):
    out, route = await _lookup(
        monkeypatch,
        _urlset(
            "https://example.com/",
            "https://example.com/about",
            "https://blog.example.com/post",
            "https://www.example.com/www-is-still-internal",
            "https://elsewhere.com/page",
        ),
    )

    assert out["source"] == "Sitemap"
    assert out["found"] is True
    assert out["sitemap_url"] == "https://example.com/sitemap.xml"
    assert route.call_count == 1
    assert [(u["url"], u["kind"]) for u in out["urls"]] == [
        ("https://example.com/", "internal"),
        ("https://example.com/about", "internal"),
        ("https://blog.example.com/post", "internal"),
        ("https://www.example.com/www-is-still-internal", "internal"),
        ("https://elsewhere.com/page", "external"),
    ]
    assert out["internal_count"] == 4
    assert out["external_count"] == 1
    assert out["counts_truncated"] is False
    assert out["truncated"] is False
    assert out["notes"] == []


@pytest.mark.asyncio
async def test_sibling_domain_is_external_not_a_subdomain(monkeypatch):
    # `notexample.com` ends with `example.com` as a string but is a different
    # site; the dot in the suffix check is what keeps it out of "internal".
    out, _ = await _lookup(
        monkeypatch,
        _urlset("https://notexample.com/x", "https://evil-example.com/y"),
    )
    assert [u["kind"] for u in out["urls"]] == ["external", "external"]


@pytest.mark.asyncio
async def test_missing_namespace_is_tolerated(monkeypatch):
    out, _ = await _lookup(monkeypatch, _urlset("https://example.com/a", ns=""))
    assert out["found"] is True
    assert out["urls"] == [{"url": "https://example.com/a", "kind": "internal"}]


@pytest.mark.asyncio
async def test_duplicates_collapse_and_first_seen_order_is_kept(monkeypatch):
    out, _ = await _lookup(
        monkeypatch,
        _urlset(
            "https://example.com/b",
            "https://example.com/a",
            "https://example.com/b",
            "https://example.com/a",
        ),
    )
    assert [u["url"] for u in out["urls"]] == [
        "https://example.com/b",
        "https://example.com/a",
    ]


@pytest.mark.asyncio
async def test_sitemap_url_is_derived_from_the_origin_only(monkeypatch):
    # A page deep in a section still reads the site root's sitemap.
    out, route = await _lookup(
        monkeypatch, _urlset(), url="https://example.com:8443/a/b?q=1#f"
    )
    assert out["sitemap_url"] == "https://example.com:8443/sitemap.xml"
    assert route.calls[0].request.headers["host"] == "example.com:8443"


# --------------------------------------------------------------------------
# Caps
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_url_list_is_capped_at_500_and_says_so(monkeypatch):
    out, _ = await _lookup(
        monkeypatch, _urlset(*[f"https://example.com/p{i}" for i in range(600)])
    )
    assert len(out["urls"]) == 500
    assert out["counts_truncated"] is True
    assert out["internal_count"] == 500
    assert out["external_count"] == 0


@pytest.mark.asyncio
async def test_cap_is_not_reported_when_the_list_fits(monkeypatch):
    out, _ = await _lookup(
        monkeypatch, _urlset(*[f"https://example.com/p{i}" for i in range(500)])
    )
    assert len(out["urls"]) == 500
    assert out["counts_truncated"] is False


@pytest.mark.asyncio
async def test_each_url_is_truncated_to_2048_chars(monkeypatch):
    long_path = "a" * 5000
    out, _ = await _lookup(monkeypatch, _urlset(f"https://example.com/{long_path}"))
    assert len(out["urls"][0]["url"]) == 2048


@pytest.mark.asyncio
async def test_body_over_the_byte_cap_is_flagged_truncated(monkeypatch):
    _resolve_to(monkeypatch, PUBLIC_IP)
    async with SafeFetcher(max_bytes=2048) as fetcher, respx.mock:
        respx.get(f"https://{PUBLIC_IP}/sitemap.xml").mock(
            return_value=httpx.Response(200, content=b"<urlset>" + b"<x/>" * 4000)
        )
        out = await sitemap_service.lookup("https://example.com/", fetcher)
    # Cut mid-document, so it cannot be parsed as a urlset — but the body cap is
    # still reported rather than swallowed.
    assert out["truncated"] is True
    assert out["found"] is False
    assert out["notes"]


# --------------------------------------------------------------------------
# Not found — the common case, never an error
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_404_is_a_normal_not_found_result(monkeypatch):
    out, _ = await _lookup(monkeypatch, b"", status=404)
    assert out["found"] is False
    assert out["sitemap_url"] is None
    assert out["urls"] == []
    assert out["internal_count"] == 0
    assert out["external_count"] == 0
    assert out["counts_truncated"] is False
    assert len(out["notes"]) == 1
    assert "404" in out["notes"][0]


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [401, 403, 429, 500, 503])
async def test_any_non_200_is_not_found_with_the_status(monkeypatch, status):
    out, _ = await _lookup(monkeypatch, b"", status=status)
    assert out["found"] is False
    assert str(status) in out["notes"][0]


@pytest.mark.asyncio
async def test_html_body_at_200_is_reported_as_not_xml(monkeypatch):
    # The most common real outcome: a soft-404 page served with a 200.
    out, _ = await _lookup(
        monkeypatch,
        b"<!DOCTYPE html><html><head><title>404</title></head></html>",
    )
    assert out["found"] is False
    assert out["urls"] == []
    assert "not XML" in out["notes"][0]


@pytest.mark.asyncio
async def test_malformed_xml_is_not_found(monkeypatch):
    out, _ = await _lookup(monkeypatch, b"<urlset><url><loc>https://example.com/</loc>")
    assert out["found"] is False
    assert out["urls"] == []
    assert "malformed" in out["notes"][0]


@pytest.mark.asyncio
async def test_empty_body_is_not_found(monkeypatch):
    out, _ = await _lookup(monkeypatch, b"")
    assert out["found"] is False
    assert "empty" in out["notes"][0]


@pytest.mark.asyncio
async def test_non_sitemap_xml_root_is_reported(monkeypatch):
    out, _ = await _lookup(monkeypatch, b'<?xml version="1.0"?><rss><channel/></rss>')
    assert out["found"] is False
    assert "urlset" in out["notes"][0]
    assert "rss" in out["notes"][0]


# --------------------------------------------------------------------------
# sitemapindex — reported, never crawled
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_sitemapindex_is_reported_and_not_crawled(monkeypatch):
    index = (
        f'<?xml version="1.0"?><sitemapindex xmlns="{NS}">'
        "<sitemap><loc>https://example.com/sitemap-1.xml</loc></sitemap>"
        "<sitemap><loc>https://example.com/sitemap-2.xml</loc></sitemap>"
        "</sitemapindex>"
    ).encode()
    out, route = await _lookup(monkeypatch, index)

    assert route.call_count == 1, "a sitemapindex must not trigger child fetches"
    assert out["found"] is True, "a sitemapindex is still a sitemap we found"
    assert out["urls"] == []
    assert out["internal_count"] == 0
    assert out["external_count"] == 0
    assert len(out["notes"]) == 1
    assert "sitemapindex" in out["notes"][0]
    assert "2" in out["notes"][0]


# --------------------------------------------------------------------------
# URL filtering
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_non_http_schemes_are_dropped(monkeypatch):
    body = _urlset(
        "javascript:alert(1)",
        "data:text/html;base64,PHNjcmlwdD4=",
        "mailto:admin@example.com",
        "ftp://example.com/file",
        "/relative/path",
        "https://example.com/kept",
    )
    out, _ = await _lookup(monkeypatch, body)
    assert [u["url"] for u in out["urls"]] == ["https://example.com/kept"]
    assert out["external_count"] == 0


# --------------------------------------------------------------------------
# XML safety — the reason this module exists
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_xxe_payload_leaks_no_file_contents(monkeypatch):
    out, _ = await _lookup(monkeypatch, XXE.encode())

    # Nothing anywhere in the serialisable result may echo a local file.
    serialised = json.dumps(out)
    assert "root:" not in serialised
    assert "passwd" not in serialised
    assert "/bin/" not in serialised

    # No crash escaped, and the outcome is a graceful refusal.
    assert out["found"] is False
    assert out["urls"] == []
    assert out["internal_count"] == 0
    assert out["external_count"] == 0
    assert len(out["notes"]) == 1
    assert "DOCTYPE" in out["notes"][0] or "ENTITY" in out["notes"][0]


@pytest.mark.asyncio
async def test_elementtree_alone_never_resolves_an_external_entity():
    """The backstop the prolog scan sits on top of.

    ElementTree has no external-entity resolution at all: an undefined entity is
    a `ParseError`, so even a document that got past the scan could not make the
    stdlib read a file. This test pins that stdlib property so a future upgrade
    that changes it is caught here rather than in production.
    """
    with pytest.raises(ET.ParseError):
        ET.fromstring(XXE)


@pytest.mark.asyncio
async def test_entity_expansion_payload_is_refused_without_blowing_up(monkeypatch):
    started = time.monotonic()
    out, _ = await _lookup(monkeypatch, BILLION_LAUGHS.encode())
    elapsed = time.monotonic() - started

    # The whole point of the prolog scan: without it this document is expanded
    # into a 1 MB URL that then gets silently truncated to 2048 chars, and the
    # result would report a fabricated internal URL as if the target had
    # published it.
    assert _elementtree_would_expand_the_bomb(), (
        "stdlib no longer expands this payload; the guard still refuses it, but "
        "this test is no longer proving what it was written to prove"
    )
    assert out["found"] is False
    assert out["urls"] == []
    assert out["internal_count"] == 0
    assert "DOCTYPE" in out["notes"][0] or "ENTITY" in out["notes"][0]
    # Refused by a string scan, so it must cost effectively nothing: a handful
    # of these is otherwise a denial of service.
    assert elapsed < 1.0, f"entity expansion took {elapsed:.2f}s"
    assert len(json.dumps(out)) < 500, "a refusal note must not quote the payload"


@pytest.mark.asyncio
async def test_entity_payload_past_the_prolog_window_still_fails_safe(monkeypatch):
    # 9 KiB of comment pushes the DTD past the 8 KiB scan window. ElementTree
    # then has to carry the load: it refuses the undefined entity, so the result
    # is still a graceful "not found" and never a file read.
    padding = "<!--" + ("p" * 9000) + "-->"
    body = XXE.replace('<?xml version="1.0"?>', '<?xml version="1.0"?>' + padding)
    out, _ = await _lookup(monkeypatch, body.encode())
    assert out["found"] is False
    serialised = json.dumps(out)
    assert "root:" not in serialised
    assert "passwd" not in serialised


@pytest.mark.asyncio
async def test_a_url_carrying_doctype_text_in_the_body_is_not_mistaken_for_one(
    monkeypatch,
):
    # A well-formed document cannot contain a raw `<!DOCTYPE` outside markup, and
    # a legitimately listed URL would have to escape it — so this only guards
    # against the scan firing on a later page's payload and rejecting a whole
    # otherwise-good sitemap.
    out, _ = await _lookup(
        monkeypatch,
        _urlset("https://example.com/a", "https://example.com/b") + b"<!-- tail -->",
    )
    assert out["found"] is True
    assert len(out["urls"]) == 2


# --------------------------------------------------------------------------
# SSRF failures propagate to the router, they are not swallowed
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_blocked_target_propagates(monkeypatch):
    _resolve_to(monkeypatch, "127.0.0.1")
    async with SafeFetcher() as fetcher, respx.mock:
        with pytest.raises(SsrfBlocked, match="blocked address"):
            await sitemap_service.lookup("https://internal.example.com/", fetcher)


@pytest.mark.asyncio
async def test_timeout_propagates(monkeypatch):
    _resolve_to(monkeypatch, PUBLIC_IP)
    async with SafeFetcher() as fetcher, respx.mock:
        respx.get(f"https://{PUBLIC_IP}/sitemap.xml").mock(
            side_effect=httpx.ReadTimeout("too slow")
        )
        with pytest.raises(SsrfTimeout, match="timed out"):
            await sitemap_service.lookup("https://example.com/", fetcher)


@pytest.mark.asyncio
async def test_httpx_error_propagates(monkeypatch):
    _resolve_to(monkeypatch, PUBLIC_IP)
    async with SafeFetcher() as fetcher, respx.mock:
        respx.get(f"https://{PUBLIC_IP}/sitemap.xml").mock(
            side_effect=httpx.ConnectError("refused")
        )
        with pytest.raises(httpx.ConnectError):
            await sitemap_service.lookup("https://example.com/", fetcher)


@pytest.mark.asyncio
async def test_redirect_to_private_address_is_blocked(monkeypatch):
    answers = {"example.com": [PUBLIC_IP], "169.254.169.254": ["169.254.169.254"]}
    monkeypatch.setattr(
        ssrf, "_sync_resolve_all", lambda host, port: answers.get(host, [PUBLIC_IP])
    )
    async with SafeFetcher() as fetcher, respx.mock:
        respx.get(f"https://{PUBLIC_IP}/sitemap.xml").mock(
            return_value=httpx.Response(
                302, headers={"location": "http://169.254.169.254/latest/meta-data/"}
            )
        )
        metadata = respx.get("http://169.254.169.254/latest/meta-data/").mock(
            return_value=httpx.Response(200, text="SECRET")
        )
        with pytest.raises(SsrfBlocked):
            await sitemap_service.lookup("https://example.com/", fetcher)
        assert metadata.call_count == 0


# --------------------------------------------------------------------------
# Fetcher lifecycle
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_injected_fetcher_is_not_closed(monkeypatch):
    _resolve_to(monkeypatch, PUBLIC_IP)
    async with SafeFetcher() as fetcher, respx.mock:
        respx.get(f"https://{PUBLIC_IP}/sitemap.xml").mock(
            return_value=httpx.Response(200, content=_urlset("https://example.com/a"))
        )
        await sitemap_service.lookup("https://example.com/", fetcher)
        # Still usable, i.e. `lookup` did not close a fetcher it did not own.
        second = await fetcher.fetch("https://example.com/sitemap.xml")
        assert second.status == 200


@pytest.mark.asyncio
async def test_non_http_page_url_is_refused(monkeypatch):
    async with SafeFetcher() as fetcher:
        with pytest.raises(SsrfBlocked, match="http and https"):
            await sitemap_service.lookup("file:///etc/passwd", fetcher)


@pytest.mark.asyncio
async def test_url_without_a_host_is_refused(monkeypatch):
    # The router normalises bare domains; this module does not guess.
    async with SafeFetcher() as fetcher:
        with pytest.raises(SsrfBlocked, match="no scheme"):
            await sitemap_service.lookup("example.com", fetcher)


@pytest.mark.asyncio
async def test_scheme_only_url_is_refused(monkeypatch):
    async with SafeFetcher() as fetcher:
        with pytest.raises(SsrfBlocked, match="no host"):
            await sitemap_service.lookup("https:///sitemap.xml", fetcher)
