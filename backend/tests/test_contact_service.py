"""Tests for the passive contact extractor.

The extractor is only a reader, so most of what is tested here is what it
refuses to do: not verify a number, not persist it, not turn a blocked fetch
into an empty result, and not report a cut-short page as a clean page.
"""

from __future__ import annotations

import json
import unicodedata

import httpx
import pytest
import respx

from app.core import cache as cache_mod
from app.core import ssrf
from app.core.ssrf import FetchResult, SafeFetcher, SsrfBlocked, SsrfTimeout
from app.services import contact_service

PUBLIC_IP = "93.184.216.34"

CONTACT_PAGE = """<!doctype html>
<html><head><title>Acme</title></head>
<body>
  <img src="/assets/logo@example.com.png" alt="x@2y">
  <h1>Contact us</h1>
  <p>Sales: <a href="mailto:sales@acme-target.com?subject=Hello">sales@acme-target.com</a></p>
  <p>Press: press@acme-target.com</p>
  <p>Main line: +1 (555) 010-9999</p>
  <p>EU desk: 0044 20 7946 0958</p>
  <p>Local: 5550109999</p>
  <p>Server 192.168.1.1 was rebuilt 2024-01-15</p>
  <footer>Docs placeholder: docs@example.com</footer>
</body></html>
"""


def _resolve_to(monkeypatch, *addresses: str) -> None:
    """Pin every resolution to a fixed answer.

    The guard resolves before it dials and then connects to the address it
    resolved, so controlling the resolver is what lets a test decide whether a
    name is reachable at all.
    """
    monkeypatch.setattr(ssrf, "_sync_resolve_all", lambda host, port: list(addresses))


def _page(monkeypatch, body: bytes, *, path: str = "/contact", **kwargs):
    """Route one page on the pinned IP.

    Called from inside `respx.mock`, the way `tests/test_ssrf.py` does it: a
    route registered on the default router outside the context can be matched
    by a leftover route instead of the one under test.
    """
    _resolve_to(monkeypatch, PUBLIC_IP)
    return respx.get(f"https://{PUBLIC_IP}{path}").mock(
        return_value=httpx.Response(200, content=body, **kwargs)
    )


def _is_clean(value: str) -> bool:
    """True when `value` carries no control, zero-width or bidi character."""
    return all(
        ch.isprintable() and not unicodedata.category(ch).startswith("C")
        for ch in value
    )


@pytest.mark.asyncio
async def test_extracts_emails_and_phones_from_a_realistic_page(monkeypatch):
    async with SafeFetcher() as fetcher, respx.mock:
        _page(monkeypatch, CONTACT_PAGE.encode("utf-8"))
        out = await contact_service.lookup("https://acme-target.com/contact", fetcher)

    assert out["source"] == "Page contacts"
    assert out["url"] == "https://acme-target.com/contact"
    assert out["status"] == 200
    assert out["counts_truncated"] is False
    assert out["truncated"] is False

    # First-seen order, and mailto before body text, because that is the order
    # the match budget is spent in.
    assert out["emails"] == [
        {"value": "sales@acme-target.com", "source": "mailto"},
        {"value": "press@acme-target.com", "source": "text"},
    ]
    assert [p["value"] for p in out["phones"]] == [
        "+1 (555) 010-9999",
        "0044 20 7946 0958",
        "5550109999",
    ]
    assert out["phones"][0] == {
        "value": "+1 (555) 010-9999",
        "digits": "15550109999",
        "looks_international": True,
        "truncated": False,
    }
    # A local number with no prefix is not claimed to be international, and a
    # region is never inferred from the digits.
    assert out["phones"][2]["looks_international"] is False
    assert out["phones"][1]["looks_international"] is True


@pytest.mark.asyncio
async def test_mailto_address_is_reported_as_mailto_and_drops_the_query(monkeypatch):
    # The address only ever appears inside an href, and the href carries a
    # subject line: neither the mailto scheme nor the query may reach the value.
    body = b'<a href="mailto:only-in-href@acme-target.com?subject=Quote%20request">Mail</a>'
    async with SafeFetcher() as fetcher, respx.mock:
        _page(monkeypatch, body)
        out = await contact_service.lookup("https://acme-target.com/contact", fetcher)

    assert out["emails"] == [
        {"value": "only-in-href@acme-target.com", "source": "mailto"}
    ]
    assert "?" not in out["emails"][0]["value"]
    assert "mailto" not in out["emails"][0]["value"]


@pytest.mark.asyncio
async def test_junk_is_filtered(monkeypatch):
    body = (
        b'<img src="/logo@example.com.png">'
        b'<img src="x@2y"><img src="team@2x">'
        b"<p>hi@localhost, dev@node.local, t@thing.test</p>"
        b"<p>support@acme-target.com</p>"
    )
    async with SafeFetcher() as fetcher, respx.mock:
        _page(monkeypatch, body)
        out = await contact_service.lookup("https://acme-target.com/contact", fetcher)

    assert [e["value"] for e in out["emails"]] == ["support@acme-target.com"]


@pytest.mark.asyncio
async def test_phone_shaped_numbers_that_are_not_numbers_are_dropped(monkeypatch):
    body = (
        b"<p>10.0.0.1 gateway, build 2024-01-15, v1.2.3.4, lot 12345</p>"
        b"<p>Real: +1 (555) 010-9999</p>"
    )
    async with SafeFetcher() as fetcher, respx.mock:
        _page(monkeypatch, body)
        out = await contact_service.lookup("https://acme-target.com/contact", fetcher)

    assert [p["value"] for p in out["phones"]] == ["+1 (555) 010-9999"]


@pytest.mark.asyncio
async def test_hard_cap_is_combined_across_emails_and_phones(monkeypatch):
    body = (
        " ".join(f"user{i}@acme-target{i}.com" for i in range(150)).encode()
        + b" "
        + " ".join(f"+1 (555) {i:03d}-9999" for i in range(150)).encode()
    )
    async with SafeFetcher() as fetcher, respx.mock:
        _page(monkeypatch, body)
        out = await contact_service.lookup("https://acme-target.com/contact", fetcher)

    # One shared budget, not one per list: the TODO authorised 100 matches.
    assert contact_service.MAX_MATCHES == 100
    assert len(out["emails"]) + len(out["phones"]) == 100
    assert out["counts_truncated"] is True
    # Emails are extracted first, so an email-heavy page starves the phones and
    # the note has to say so rather than let the empty list read as "none".
    assert out["phones"] == []
    assert len(out["emails"]) == 100
    assert "cap" in out["note"]


@pytest.mark.asyncio
async def test_a_page_exactly_at_the_cap_is_not_reported_as_truncated(monkeypatch):
    # Stopping at the cap is not the same as hitting it: 100 matches and no
    # 101st candidate must not claim that matches were dropped.
    body = " ".join(f"user{i}@acme-target{i}.com" for i in range(100)).encode()
    async with SafeFetcher() as fetcher, respx.mock:
        _page(monkeypatch, body)
        out = await contact_service.lookup("https://acme-target.com/contact", fetcher)

    assert len(out["emails"]) == 100
    assert out["counts_truncated"] is False


@pytest.mark.asyncio
async def test_control_characters_are_stripped(monkeypatch):
    # A NUL inside the email and a bidi override inside the phone. Cleaning each
    # match on its own would hand back the phone prefix `+1 (555) 010` and pass
    # it off as a complete number; the body is cleaned before matching instead.
    body = b"<p>Call +1 (555) 010-\x009999\xe2\x80\xae or mail s\x00ales@acme-target.com</p>"
    async with SafeFetcher() as fetcher, respx.mock:
        _page(monkeypatch, body)
        out = await contact_service.lookup("https://acme-target.com/contact", fetcher)

    assert out["phones"] == [
        {
            "value": "+1 (555) 010-9999",
            "digits": "15550109999",
            "looks_international": True,
            "truncated": False,
        }
    ]
    assert [e["value"] for e in out["emails"]] == ["sales@acme-target.com"]
    for entry in out["emails"] + out["phones"]:
        assert _is_clean(entry["value"]), repr(entry["value"])


@pytest.mark.asyncio
async def test_values_are_capped_and_a_clipped_phone_is_flagged(monkeypatch):
    # 37 characters, 15 digits: past the 32-char phone cap, so it is clipped.
    # Clipping a phone changes the number, which is why the entry says so
    # instead of quietly looking like a complete one.
    long_phone = "00(1234).--(567).--(890).--(123).--45"
    assert len(long_phone) > contact_service.MAX_PHONE_LEN
    async with SafeFetcher() as fetcher, respx.mock:
        _page(monkeypatch, f"<p>Desk: {long_phone}</p>".encode())
        out = await contact_service.lookup("https://acme-target.com/contact", fetcher)

    phone = out["phones"][0]
    assert len(phone["value"]) == contact_service.MAX_PHONE_LEN == 32
    assert phone["value"] != long_phone
    assert phone["truncated"] is True
    # Still a dialable-length number, and still balanced.
    assert 7 <= len(phone["digits"]) <= 15
    assert phone["value"].count("(") == phone["value"].count(")")

    assert contact_service.MAX_EMAIL_LEN == 254
    for entry in out["emails"]:
        assert len(entry["value"]) <= contact_service.MAX_EMAIL_LEN


@pytest.mark.asyncio
async def test_an_over_long_email_is_rejected_not_clipped(monkeypatch):
    # Clipping an address would produce a different address that still looks
    # deliverable, so one past the RFC 254-char limit is dropped outright.
    body = f'<a href="mailto:{"a" * 250}@acme-target.com">x</a>'.encode()
    async with SafeFetcher() as fetcher, respx.mock:
        _page(monkeypatch, body)
        out = await contact_service.lookup("https://acme-target.com/contact", fetcher)

    assert out["emails"] == []


@pytest.mark.asyncio
async def test_duplicates_collapse_and_first_seen_order_is_kept(monkeypatch):
    body = (
        b"<p>second@acme-target.com then first@acme-target.com</p>"
        b"<p>first@acme-target.com again, SECOND@acme-target.com</p>"
        b"<p>+1-555-010-9999 and +1 (555) 010-9999 and 5550109999</p>"
    )
    async with SafeFetcher() as fetcher, respx.mock:
        _page(monkeypatch, body)
        out = await contact_service.lookup("https://acme-target.com/contact", fetcher)

    # Case-insensitive for addresses, digit-wise for phones, so the same number
    # written three ways is one entry and the first spelling wins.
    assert [e["value"] for e in out["emails"]] == [
        "second@acme-target.com",
        "first@acme-target.com",
    ]
    assert [p["digits"] for p in out["phones"]] == ["15550109999", "5550109999"]


@pytest.mark.asyncio
async def test_ssrf_blocked_propagates(monkeypatch):
    # A blocked target must not be reported as "published no contacts".
    _resolve_to(monkeypatch, "127.0.0.1")
    async with SafeFetcher() as fetcher:
        with pytest.raises(SsrfBlocked, match="blocked address"):
            await contact_service.lookup("http://internal.acme-target.com/", fetcher)


@pytest.mark.asyncio
async def test_ssrf_timeout_propagates(monkeypatch):
    _resolve_to(monkeypatch, PUBLIC_IP)
    async with SafeFetcher() as fetcher, respx.mock:
        respx.get(f"https://{PUBLIC_IP}/contact").mock(
            side_effect=httpx.ReadTimeout("too slow")
        )
        with pytest.raises(SsrfTimeout):
            await contact_service.lookup("https://acme-target.com/contact", fetcher)


@pytest.mark.asyncio
async def test_httpx_transport_error_propagates(monkeypatch):
    _resolve_to(monkeypatch, PUBLIC_IP)
    async with SafeFetcher() as fetcher, respx.mock:
        respx.get(f"https://{PUBLIC_IP}/contact").mock(
            side_effect=httpx.ConnectError("refused")
        )
        with pytest.raises(httpx.ConnectError):
            await contact_service.lookup("https://acme-target.com/contact", fetcher)


@pytest.mark.asyncio
async def test_a_truncated_body_is_partial_coverage_not_a_clean_page(monkeypatch):
    # The guard cut the body before any contact detail, so the honest answer is
    # "partial coverage", not "no contacts".
    body = (
        b"<p>" + b"filler text " * 200 + b"press@acme-target.com +1 (555) 010-9999</p>"
    )
    _resolve_to(monkeypatch, PUBLIC_IP)
    async with SafeFetcher(max_bytes=256) as fetcher, respx.mock:
        route = _page(monkeypatch, body)
        out = await contact_service.lookup("https://acme-target.com/contact", fetcher)

    assert route.call_count == 1
    assert out["truncated"] is True
    assert out["emails"] == [] and out["phones"] == []
    assert out["counts_truncated"] is False
    assert "partial coverage" in out["note"]
    assert "no match is not proof of none" in out["note"]


@pytest.mark.asyncio
async def test_a_truncated_body_still_reports_what_it_did_capture(monkeypatch):
    body = b"<p>press@acme-target.com</p>" + b"filler " * 200
    _resolve_to(monkeypatch, PUBLIC_IP)
    async with SafeFetcher(max_bytes=512) as fetcher, respx.mock:
        _page(monkeypatch, body)
        out = await contact_service.lookup("https://acme-target.com/contact", fetcher)

    assert out["truncated"] is True
    assert [e["value"] for e in out["emails"]] == ["press@acme-target.com"]
    assert "partial coverage" in out["note"]


@pytest.mark.asyncio
async def test_an_injected_fetcher_is_reused_and_left_open(monkeypatch):
    async with SafeFetcher() as fetcher, respx.mock:
        route = _page(monkeypatch, CONTACT_PAGE.encode("utf-8"))
        first = await contact_service.lookup("https://acme-target.com/contact", fetcher)
        second = await contact_service.lookup(
            "https://acme-target.com/contact", fetcher
        )

    # The caller owns an injected fetcher; closing it here would break the
    # orchestrator's shared client for every source after this one.
    assert route.call_count == 2
    assert first["emails"] == second["emails"]
    assert first["phones"] == second["phones"]


@pytest.mark.asyncio
async def test_it_builds_and_closes_its_own_fetcher_when_none_is_given(monkeypatch):
    async with respx.mock:
        route = _page(monkeypatch, CONTACT_PAGE.encode("utf-8"))
        out = await contact_service.lookup("https://acme-target.com/contact")

    assert route.call_count == 1
    assert [e["value"] for e in out["emails"]] == [
        "sales@acme-target.com",
        "press@acme-target.com",
    ]


@pytest.mark.asyncio
async def test_a_non_text_body_is_not_regexed(monkeypatch):
    _resolve_to(monkeypatch, PUBLIC_IP)
    async with SafeFetcher() as fetcher, respx.mock:
        respx.get(f"https://{PUBLIC_IP}/logo.png").mock(
            return_value=httpx.Response(
                200,
                content=b"\x89PNG\r\n sales@acme-target.com +1 (555) 010-9999",
                headers={"content-type": "image/png"},
            )
        )
        out = await contact_service.lookup("https://acme-target.com/logo.png", fetcher)

    assert out["emails"] == [] and out["phones"] == []
    assert "image/png" in out["note"]


@pytest.mark.asyncio
async def test_an_error_page_is_reported_with_its_status(monkeypatch):
    _resolve_to(monkeypatch, PUBLIC_IP)
    async with SafeFetcher() as fetcher, respx.mock:
        respx.get(f"https://{PUBLIC_IP}/contact").mock(
            return_value=httpx.Response(
                404,
                content=b"<p>Not found. Try support@acme-target.com</p>",
                headers={"content-type": "text/html"},
            )
        )
        out = await contact_service.lookup("https://acme-target.com/contact", fetcher)

    # The page really did publish that address, so it is reported - but the
    # status travels with it, because a 404 body is not a contact page.
    assert out["status"] == 404
    assert [e["value"] for e in out["emails"]] == ["support@acme-target.com"]
    assert "404" in out["note"]


@pytest.mark.asyncio
async def test_a_page_with_no_contacts_is_an_empty_result_not_an_error(monkeypatch):
    async with SafeFetcher() as fetcher, respx.mock:
        _page(monkeypatch, b"<html><body><p>Nothing here.</p></body></html>")
        out = await contact_service.lookup("https://acme-target.com/contact", fetcher)

    assert out["emails"] == [] and out["phones"] == []
    assert out["counts_truncated"] is False
    assert "No email or phone pattern matched" in out["note"]


@pytest.mark.asyncio
async def test_nothing_is_persisted_and_the_result_is_plain_json(monkeypatch):
    """The caller owns persistence; this module must not write anything."""
    writes: list[str] = []

    def _spy_set(*args, **kwargs):
        writes.append("cache_set")

    async def _spy_set_async(*args, **kwargs):
        writes.append("cache_set_async")

    monkeypatch.setattr(cache_mod, "cache_set", _spy_set)
    monkeypatch.setattr(cache_mod, "cache_set_async", _spy_set_async)

    async with SafeFetcher() as fetcher, respx.mock:
        _page(monkeypatch, CONTACT_PAGE.encode("utf-8"))
        out = await contact_service.lookup("https://acme-target.com/contact", fetcher)

    assert writes == []
    # Plain JSON in, plain JSON out: no dataclass, bytes or enum leaking into a
    # snapshot the caller has to store.
    assert json.loads(json.dumps(out)) == out


def test_the_combined_cap_reading_is_in_every_note():
    # The cap reading has to be in the payload, not only in the docstring: the
    # UI is where a caller learns which of the two lists got starved.
    result = FetchResult(
        requested_url="https://acme-target.com/contact",
        final_url="https://acme-target.com/contact",
        status=200,
        ip=PUBLIC_IP,
        headers=httpx.Headers({"content-type": "text/html"}),
        content=b"<p>hi@acme-target.com</p>",
        truncated=False,
        hops=(),
    )
    out = contact_service._summarize(result)

    assert contact_service.MAX_MATCHES == 100
    assert out["match_cap"] == 100
    assert "100" in out["note"]
    assert "combined" in out["note"]
    assert "verified" in out["note"]
