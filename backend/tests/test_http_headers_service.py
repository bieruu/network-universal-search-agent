"""Tests for the headers/cookies observation service.

The credential test is the one that matters here: a `Set-Cookie` value is a
live session, so the whole test file is built around proving the value never
reaches the returned structure, and that nothing else quietly reintroduces it.
"""

from __future__ import annotations

import json

import httpx
import pytest

from app.core import ssrf
from app.core.ssrf import FetchResult, SafeFetcher, SsrfBlocked
from app.services import http_headers_service

PUBLIC_IP = "93.184.216.34"
# A planted session value. It appears only in Set-Cookie headers, and no test
# may ever let it reach the output.
SECRET = "s3cr3t-session-token-9f2b1c"


def _result(
    headers,
    *,
    status: int = 200,
    content: bytes = b"",
    truncated: bool = False,
    final_url: str = "http://example.com/",
) -> FetchResult:
    """A real FetchResult, so the service reads genuine httpx.Headers."""
    return FetchResult(
        requested_url=final_url,
        final_url=final_url,
        status=status,
        ip=PUBLIC_IP,
        headers=httpx.Headers(headers),
        content=content,
        truncated=truncated,
        hops=(),
    )


class _FakeFetcher:
    """Stands in for SafeFetcher so this file tests the service, not the guard.

    The guard has its own suite (tests/test_ssrf.py); the one guard behaviour
    asserted here is that the service does not interfere with its exceptions.
    """

    def __init__(self, result=None, error: Exception | None = None) -> None:
        self._result = result
        self._error = error
        self.fetched: list[str] = []
        self.closed = 0

    async def fetch(self, url: str) -> FetchResult:
        self.fetched.append(url)
        if self._error is not None:
            raise self._error
        return self._result

    async def aclose(self) -> None:
        self.closed += 1


async def _run(headers, **kwargs) -> dict:
    return await http_headers_service.lookup(
        "http://example.com/", fetcher=_FakeFetcher(_result(headers, **kwargs))
    )


@pytest.mark.asyncio
async def test_cookie_value_never_appears_in_the_result():
    """The headline rule: the credential is absent, not masked."""
    result = await _run(
        [
            ("Set-Cookie", f"session={SECRET}; Path=/; Secure; HttpOnly"),
            ("Set-Cookie", f"refresh={SECRET}; Domain=example.com; SameSite=Strict"),
            ("Server", "nginx"),
        ]
    )

    serialized = json.dumps(result)
    assert SECRET not in serialized
    # Not just the JSON view: nothing anywhere in the structure carries it.
    assert SECRET not in repr(result)

    # The cookie is still observable — by name and attributes, which is what
    # the card renders and what a snapshot is allowed to keep.
    assert [cookie["name"] for cookie in result["cookies"]] == ["session", "refresh"]
    assert result["cookies"][0]["secure"] is True

    # The raw Set-Cookie header is not echoed either, in any spelling.
    cookie_headers = [
        header for header in result["headers"] if header["name"] == "set-cookie"
    ]
    assert len(cookie_headers) == 2
    for header in cookie_headers:
        assert header["value"] == "[redacted]"


@pytest.mark.asyncio
async def test_every_set_cookie_header_is_parsed_not_collapsed():
    """.get() would merge two cookies into one unparseable row."""
    result = await _run(
        [
            ("Set-Cookie", "first=1; Path=/"),
            ("Set-Cookie", "second=2; Path=/"),
            ("Set-Cookie", "third=3; Path=/"),
        ]
    )

    assert result["cookie_count"] == 3
    assert [cookie["name"] for cookie in result["cookies"]] == [
        "first",
        "second",
        "third",
    ]


@pytest.mark.asyncio
async def test_malformed_set_cookie_is_skipped_without_raising():
    """A target sending garbage must degrade this card, not fail the scan."""
    result = await _run(
        [
            ("Set-Cookie", ""),
            ("Set-Cookie", "garbage-without-a-pair"),
            ("Set-Cookie", "=novalue"),
            ("Set-Cookie", "; ; ;"),
            ("Set-Cookie", 'name="unterminated; Path=/'),
            ("Set-Cookie", "session=; Path=/"),
        ]
    )

    # Only the cookies that actually name something survive, and the
    # unterminated-quote one is reported with empty attributes rather than
    # raising — its attributes are not invented. An empty *value* is a
    # deletion, not a malformed header, so `session` is kept.
    assert [cookie["name"] for cookie in result["cookies"]] == ["name", "session"]
    assert result["cookies"][0]["path"] is None
    assert result["cookies"][0]["domain"] is None
    assert result["cookies"][1]["path"] == "/"
    assert result["cookie_count"] == 2
    # Nothing from the garbage leaked into the attributes either.
    assert "unterminated" not in json.dumps(result["cookies"])


@pytest.mark.asyncio
async def test_cookie_attributes_are_extracted():
    cookie = (
        "sid=abc123; Domain=app.example.com; Path=/api; Secure; HttpOnly; "
        "SameSite=Lax; Max-Age=3600; Expires=Thu, 01 Jan 2032 00:00:00 GMT"
    )
    result = await _run([("Set-Cookie", cookie)])

    cookie = result["cookies"][0]
    assert cookie == {
        "name": "sid",
        "domain": "app.example.com",
        "path": "/api",
        "secure": True,
        "http_only": True,
        "same_site": "Lax",
        "expires": "Thu, 01 Jan 2032 00:00:00 GMT",
        "max_age": "3600",
    }


@pytest.mark.asyncio
async def test_cookie_without_attributes_reports_empty_attributes():
    result = await _run([("Set-Cookie", "bare=1")])

    cookie = result["cookies"][0]
    assert cookie["name"] == "bare"
    assert cookie["domain"] is None
    assert cookie["path"] is None
    assert cookie["secure"] is False
    assert cookie["http_only"] is False
    assert cookie["same_site"] is None
    assert cookie["expires"] is None
    assert cookie["max_age"] is None


@pytest.mark.asyncio
async def test_attribute_parsing_ignores_case_and_unknown_attributes():
    # Attribute names are case-insensitive on the wire, and the origin may
    # send attributes this module does not model (Partitioned, Priority, ...).
    cookie = (
        "a=1; SECURE; httponly; SAMESITE=STRICT; PARTITIONED; "
        "Priority=High; Custom-Thing=whatever"
    )
    result = await _run([("Set-Cookie", cookie)])

    cookie = result["cookies"][0]
    assert cookie["secure"] is True
    assert cookie["http_only"] is True
    assert cookie["same_site"] == "STRICT"
    assert set(cookie) == {
        "name",
        "domain",
        "path",
        "secure",
        "http_only",
        "same_site",
        "expires",
        "max_age",
    }


@pytest.mark.asyncio
async def test_quoted_value_with_semicolon_does_not_break_parsing():
    """A naive `;` split turns the tail of a quoted value into attributes."""
    result = await _run([("Set-Cookie", 'a="x;y"; Path=/admin; Secure')])

    cookie = result["cookies"][0]
    assert cookie["name"] == "a"
    assert cookie["path"] == "/admin"
    assert cookie["secure"] is True
    # The quoted value is dropped with every other value, and the `y"` tail a
    # naive split would have read as an attribute is not invented anywhere:
    # `path` is the only string attribute present.
    assert '"x;y"' not in json.dumps(result)
    assert {k: v for k, v in cookie.items() if isinstance(v, str)} == {
        "name": "a",
        "path": "/admin",
    }


@pytest.mark.asyncio
async def test_duplicate_attribute_keeps_the_first_value():
    result = await _run([("Set-Cookie", "a=1; Path=/first; Path=/second")])
    assert result["cookies"][0]["path"] == "/first"


@pytest.mark.asyncio
async def test_set_cookie2_alias_is_not_silently_dropped():
    # Deprecated by RFC 6265, but a target sending it still set a cookie.
    result = await _run(
        [("Set-Cookie", "a=1; Path=/"), ("Set-Cookie2", "b=2; Path=/; Secure")]
    )

    assert [cookie["name"] for cookie in result["cookies"]] == ["a", "b"]
    assert result["cookies"][1]["secure"] is True


@pytest.mark.asyncio
async def test_target_with_no_cookies_returns_empty_list_not_an_error():
    result = await _run([("Server", "nginx"), ("Content-Type", "text/html")])

    assert result["cookies"] == []
    assert result["cookie_count"] == 0
    assert result["cookies_truncated"] is False
    # The rest of the response is still reported: no cookies is a normal
    # observation, not a failed lookup.
    assert result["status"] == 200
    assert result["header_count"] == 2


@pytest.mark.asyncio
async def test_header_list_is_capped_and_says_so():
    headers = [(f"X-Pad-{index}", str(index)) for index in range(150)]
    result = await _run(headers)

    assert result["header_count"] == 100
    assert len(result["headers"]) == 100
    assert result["headers_truncated"] is True
    assert result["headers"][0]["name"] == "x-pad-0"


@pytest.mark.asyncio
async def test_cookie_list_is_capped_and_says_so():
    headers = [("set-cookie", f"c{index}=v{index}; Path=/") for index in range(120)]
    result = await _run(headers)

    assert result["cookie_count"] == 100
    assert len(result["cookies"]) == 100
    assert result["cookies_truncated"] is True


@pytest.mark.asyncio
async def test_uncapped_lists_are_not_marked_truncated():
    headers = [("set-cookie", f"c{index}=v{index}") for index in range(100)]
    result = await _run(headers)

    assert result["cookies_truncated"] is False
    assert result["headers_truncated"] is False


@pytest.mark.asyncio
async def test_long_header_value_is_capped_at_2048_chars():
    result = await _run([("X-Long", "A" * 5000)])

    value = result["headers"][0]["value"]
    assert len(value) == 2048


@pytest.mark.asyncio
async def test_long_cookie_attributes_are_capped():
    result = await _run([("Set-Cookie", f"a=1; Domain={'b' * 4000}; Path=/")])

    assert len(result["cookies"][0]["domain"]) == 1024
    assert result["cookies"][0]["path"] == "/"


@pytest.mark.asyncio
async def test_header_values_are_plain_text_without_control_characters():
    # Header values are attacker-chosen and end up in a rendered card, so an
    # ESC/newline must not survive into the text the dashboard displays.
    result = await _run(
        [
            ("X-Attempt", "<script>alert(1)</script>\x1b[31mred\r\nInjected: 1"),
            ("X-Authorization-Echo", "Bearer leaked-token-should-not-render"),
        ]
    )

    injected = next(h for h in result["headers"] if h["name"] == "x-attempt")
    assert injected["value"] == "<script>alert(1)</script>[31mredInjected: 1"
    assert "\x1b" not in injected["value"]
    assert "\n" not in injected["value"]
    # Markup is preserved verbatim rather than stripped: it is reported as
    # text, and the frontend renders header values as text (AGENTS.md §6). The
    # control characters are removed because they are not display text at all.
    assert "<script>" in injected["value"]


@pytest.mark.asyncio
async def test_credential_headers_are_never_emitted():
    result = await _run(
        [
            ("Authorization", "Bearer server-echoed-secret"),
            ("Proxy-Authorization", "Basic ZG9sbw=="),
            ("Server", "nginx"),
        ]
    )

    assert "server-echoed-secret" not in json.dumps(result)
    assert "ZG9sbw" not in json.dumps(result)
    values = {header["name"]: header["value"] for header in result["headers"]}
    assert values["authorization"] == "[redacted]"
    assert values["proxy-authorization"] == "[redacted]"
    assert values["server"] == "nginx"


@pytest.mark.asyncio
async def test_repeated_non_cookie_headers_are_all_kept():
    result = await _run([("X-Foo", "1"), ("X-Foo", "2"), ("X-Foo", "3")])

    assert [header["value"] for header in result["headers"]] == ["1", "2", "3"]
    assert result["header_count"] == 3


@pytest.mark.asyncio
async def test_status_url_and_body_truncation_are_reported():
    result = await _run(
        [("Server", "nginx")],
        status=404,
        truncated=True,
        final_url="http://example.com/missing",
    )

    assert result["source"] == "HTTP response"
    assert result["status"] == 404
    assert result["url"] == "http://example.com/missing"
    # The body was cut by the fetcher's byte cap. The body itself is not part
    # of this observation, but the cap is worth surfacing.
    assert result["truncated"] is True


@pytest.mark.asyncio
async def test_result_is_json_serialisable():
    result = await _run(
        [
            ("Set-Cookie", f"a={SECRET}; Path=/; Secure"),
            ("Server", "nginx"),
        ]
    )
    assert json.loads(json.dumps(result)) == result


@pytest.mark.asyncio
async def test_ssrf_blocked_propagates(monkeypatch):
    """A blocked target is a policy decision, not an empty result."""
    monkeypatch.setattr(ssrf, "_sync_resolve_all", lambda host, port: ["127.0.0.1"])
    with pytest.raises(SsrfBlocked, match="blocked address"):
        await http_headers_service.lookup("http://internal.example.com/")


@pytest.mark.asyncio
async def test_non_http_scheme_propagates(monkeypatch):
    monkeypatch.setattr(ssrf, "_sync_resolve_all", lambda host, port: [PUBLIC_IP])
    with pytest.raises(SsrfBlocked, match="http and https"):
        await http_headers_service.lookup("file:///etc/passwd")


@pytest.mark.asyncio
async def test_network_errors_are_not_swallowed():
    fetcher = _FakeFetcher(error=httpx.ConnectError("refused"))
    with pytest.raises(httpx.ConnectError):
        await http_headers_service.lookup("http://example.com/", fetcher=fetcher)


@pytest.mark.asyncio
async def test_injected_fetcher_is_used_and_left_open():
    """A shared fetcher belongs to the caller; closing it would break siblings."""
    fetcher = _FakeFetcher(_result([("Server", "nginx")]))
    result = await http_headers_service.lookup("http://example.com/", fetcher=fetcher)

    assert fetcher.fetched == ["http://example.com/"]
    assert fetcher.closed == 0
    assert result["status"] == 200


@pytest.mark.asyncio
async def test_owned_fetcher_is_created_and_closed(monkeypatch):
    fetcher = _FakeFetcher(_result([("Server", "nginx")]))
    monkeypatch.setattr(http_headers_service, "SafeFetcher", lambda: fetcher)

    await http_headers_service.lookup("http://example.com/")

    assert fetcher.fetched == ["http://example.com/"]
    assert fetcher.closed == 1


@pytest.mark.asyncio
async def test_owned_fetcher_is_closed_even_when_the_fetch_raises(monkeypatch):
    fetcher = _FakeFetcher(error=SsrfBlocked("blocked"))
    monkeypatch.setattr(http_headers_service, "SafeFetcher", lambda: fetcher)

    with pytest.raises(SsrfBlocked):
        await http_headers_service.lookup("http://example.com/")

    assert fetcher.closed == 1


@pytest.mark.asyncio
async def test_real_safefetcher_is_accepted(monkeypatch):
    """The stub has the same surface, but the guard is what production passes."""
    monkeypatch.setattr(ssrf, "_sync_resolve_all", lambda host, port: ["127.0.0.1"])
    async with SafeFetcher() as fetcher:
        with pytest.raises(SsrfBlocked):
            await http_headers_service.lookup("http://example.com/", fetcher=fetcher)
