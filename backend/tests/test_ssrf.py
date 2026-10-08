from __future__ import annotations

import httpx
import pytest
import respx

from app.core import ssrf
from app.core.ssrf import (
    SafeFetcher,
    SsrfBlocked,
    SsrfTimeout,
    SsrfTooManyRedirects,
)

PUBLIC_IP = "93.184.216.34"
OTHER_PUBLIC_IP = "8.8.8.8"


def _resolve_to(monkeypatch, *addresses: str) -> None:
    """Pin every resolution to a fixed answer.

    The guard resolves before it connects and then dials the address it resolved,
    so controlling the resolver is what lets a test make a *public* name point at
    a private address — which is exactly the confusion the guard must survive.
    """
    monkeypatch.setattr(ssrf, "_sync_resolve_all", lambda host, port: list(addresses))


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "gopher://example.com:70/",
        "ftp://example.com/x",
        "dict://example.com:11211/",
    ],
)
async def test_non_http_schemes_blocked(url):
    async with SafeFetcher() as fetcher:
        with pytest.raises(SsrfBlocked, match="http and https"):
            await fetcher.fetch(url)


@pytest.mark.asyncio
async def test_userinfo_url_blocked():
    # Ambiguous between "host" and "userinfo" readings; refusing removes the
    # ambiguity rather than picking one.
    async with SafeFetcher() as fetcher:
        with pytest.raises(SsrfBlocked, match="credentials"):
            await fetcher.fetch("http://example.com@127.0.0.1/")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "address",
    ["127.0.0.1", "169.254.169.254", "10.0.0.5", "192.168.1.1", "::1", "fc00::1"],
)
async def test_private_resolution_blocked(monkeypatch, address):
    _resolve_to(monkeypatch, address)
    async with SafeFetcher() as fetcher:
        with pytest.raises(SsrfBlocked, match="blocked address"):
            await fetcher.fetch("http://internal.example.com/")


@pytest.mark.asyncio
async def test_unspecified_address_blocked(monkeypatch):
    # Regression: 0.0.0.0 is not is_private/is_loopback/is_reserved in Python's
    # ipaddress, but Linux connects it to the loopback interface, so it reached
    # the backend before is_unspecified was added to the guard.
    _resolve_to(monkeypatch, "0.0.0.0")
    async with SafeFetcher() as fetcher:
        with pytest.raises(SsrfBlocked, match="blocked address"):
            await fetcher.fetch("http://zero.example.com/")


@pytest.mark.asyncio
async def test_one_private_answer_poisons_the_whole_name(monkeypatch):
    # A name answering with both a public and a private address must be refused
    # outright: which one the socket picks is not ours to decide.
    _resolve_to(monkeypatch, PUBLIC_IP, "127.0.0.1")
    async with SafeFetcher() as fetcher:
        with pytest.raises(SsrfBlocked, match="blocked address"):
            await fetcher.fetch("http://mixed.example.com/")


@pytest.mark.asyncio
async def test_empty_resolution_fails_closed(monkeypatch):
    monkeypatch.setattr(ssrf, "_sync_resolve_all", lambda host, port: [])
    async with SafeFetcher() as fetcher:
        with pytest.raises(SsrfBlocked, match="did not resolve"):
            await fetcher.fetch("http://example.com/")


@pytest.mark.asyncio
async def test_resolver_error_fails_closed(monkeypatch):
    def _boom(host, port):
        raise OSError("NXDOMAIN")

    monkeypatch.setattr(ssrf, "_sync_resolve_all", _boom)
    async with SafeFetcher() as fetcher:
        with pytest.raises(SsrfBlocked, match="could not be resolved"):
            await fetcher.fetch("http://example.com/")


@pytest.mark.asyncio
async def test_pins_to_validated_ip_and_restores_host_header(monkeypatch):
    """The socket must go to the IP we approved, not re-resolve the name."""
    _resolve_to(monkeypatch, PUBLIC_IP)
    async with SafeFetcher() as fetcher, respx.mock:
        route = respx.get(f"http://{PUBLIC_IP}/").mock(
            return_value=httpx.Response(200, text="ok")
        )
        result = await fetcher.fetch("http://example.com/")

        assert result.status == 200
        assert result.ip == PUBLIC_IP
        sent = route.calls[0].request
        assert sent.url.host == PUBLIC_IP
        # Host must be the name the target expects, or it 400s instead of serving.
        assert sent.headers["host"] == "example.com"


@pytest.mark.asyncio
async def test_host_header_keeps_non_default_port(monkeypatch):
    _resolve_to(monkeypatch, PUBLIC_IP)
    async with SafeFetcher() as fetcher, respx.mock:
        route = respx.get(f"http://{PUBLIC_IP}:8080/").mock(
            return_value=httpx.Response(200, text="ok")
        )
        await fetcher.fetch("http://example.com:8080/")
        assert route.calls[0].request.headers["host"] == "example.com:8080"


@pytest.mark.asyncio
async def test_https_sets_sni_to_the_hostname(monkeypatch):
    _resolve_to(monkeypatch, PUBLIC_IP)
    async with SafeFetcher() as fetcher, respx.mock:
        route = respx.get(f"https://{PUBLIC_IP}/").mock(
            return_value=httpx.Response(200, text="ok")
        )
        await fetcher.fetch("https://example.com/")
        # Without SNI, every https fetch fails on a certificate mismatch.
        assert route.calls[0].request.extensions["sni_hostname"] == "example.com"


@pytest.mark.asyncio
async def test_redirect_chain_is_followed_and_recorded(monkeypatch):
    _resolve_to(monkeypatch, PUBLIC_IP)
    async with SafeFetcher() as fetcher, respx.mock:
        respx.get(f"http://{PUBLIC_IP}/").mock(
            return_value=httpx.Response(301, headers={"location": "/next"})
        )
        respx.get(f"http://{PUBLIC_IP}/next").mock(
            return_value=httpx.Response(302, headers={"location": "/final"})
        )
        respx.get(f"http://{PUBLIC_IP}/final").mock(
            return_value=httpx.Response(200, text="done")
        )
        result = await fetcher.fetch("http://example.com/")

    assert result.status == 200
    assert result.content == b"done"
    # Reported in hostname form, never the pinned IP: the UI shows this, and
    # leaking our internal pinning into it would be noise at best.
    assert result.final_url == "http://example.com/final"
    assert [hop.url for hop in result.hops] == [
        "http://example.com/",
        "http://example.com/next",
        "http://example.com/final",
    ]
    assert [hop.status for hop in result.hops] == [301, 302, 200]
    assert result.redirect_count == 2


@pytest.mark.asyncio
async def test_redirect_to_private_address_is_blocked(monkeypatch):
    """The headline case: a 302 to the cloud metadata endpoint."""
    answers = {"example.com": [PUBLIC_IP], "169.254.169.254": ["169.254.169.254"]}
    monkeypatch.setattr(
        ssrf, "_sync_resolve_all", lambda host, port: answers.get(host, [PUBLIC_IP])
    )
    async with SafeFetcher() as fetcher, respx.mock:
        respx.get(f"http://{PUBLIC_IP}/").mock(
            return_value=httpx.Response(
                302, headers={"location": "http://169.254.169.254/latest/meta-data/"}
            )
        )
        metadata = respx.get("http://169.254.169.254/latest/meta-data/").mock(
            return_value=httpx.Response(200, text="SECRET")
        )
        with pytest.raises(SsrfBlocked, match="blocked address"):
            await fetcher.fetch("http://example.com/")

        assert metadata.call_count == 0, "the blocked hop must never be requested"


@pytest.mark.asyncio
async def test_redirect_loop_is_capped(monkeypatch):
    _resolve_to(monkeypatch, PUBLIC_IP)
    async with SafeFetcher(max_redirects=3) as fetcher, respx.mock:
        respx.get(f"http://{PUBLIC_IP}/").mock(
            return_value=httpx.Response(302, headers={"location": "/loop"})
        )
        respx.get(f"http://{PUBLIC_IP}/loop").mock(
            return_value=httpx.Response(302, headers={"location": "/"})
        )
        with pytest.raises(SsrfTooManyRedirects, match="3 hops"):
            await fetcher.fetch("http://example.com/")


@pytest.mark.asyncio
async def test_response_bytes_are_capped(monkeypatch):
    _resolve_to(monkeypatch, PUBLIC_IP)
    async with SafeFetcher(max_bytes=1024) as fetcher, respx.mock:
        respx.get(f"http://{PUBLIC_IP}/").mock(
            return_value=httpx.Response(200, content=b"A" * 100_000)
        )
        result = await fetcher.fetch("http://example.com/")

    assert result.truncated is True
    assert len(result.content) == 1024


@pytest.mark.asyncio
async def test_body_under_the_cap_is_not_marked_truncated(monkeypatch):
    _resolve_to(monkeypatch, PUBLIC_IP)
    async with SafeFetcher(max_bytes=1024) as fetcher, respx.mock:
        respx.get(f"http://{PUBLIC_IP}/").mock(
            return_value=httpx.Response(200, content=b"A" * 10)
        )
        result = await fetcher.fetch("http://example.com/")
    assert result.truncated is False
    assert len(result.content) == 10


@pytest.mark.asyncio
async def test_redirect_body_is_never_downloaded(monkeypatch):
    # A redirect body is never needed; reading it hands a hostile origin an
    # unbounded download on every hop of the chain.
    _resolve_to(monkeypatch, PUBLIC_IP)
    async with SafeFetcher(max_bytes=1024) as fetcher, respx.mock:
        respx.get(f"http://{PUBLIC_IP}/").mock(
            return_value=httpx.Response(
                302,
                headers={"location": "/end"},
                content=b"B" * 500_000,
            )
        )
        respx.get(f"http://{PUBLIC_IP}/end").mock(
            return_value=httpx.Response(200, content=b"ok")
        )
        result = await fetcher.fetch("http://example.com/")

    assert result.content == b"ok"
    assert result.truncated is False


@pytest.mark.asyncio
async def test_timeout_is_translated(monkeypatch):
    _resolve_to(monkeypatch, PUBLIC_IP)
    async with SafeFetcher() as fetcher, respx.mock:
        respx.get(f"http://{PUBLIC_IP}/").mock(
            side_effect=httpx.ReadTimeout("too slow")
        )
        with pytest.raises(SsrfTimeout, match="timed out"):
            await fetcher.fetch("http://example.com/")


@pytest.mark.asyncio
async def test_oversized_url_rejected():
    async with SafeFetcher() as fetcher:
        with pytest.raises(SsrfBlocked, match="too long"):
            await fetcher.fetch("http://example.com/" + "a" * 3000)


@pytest.mark.asyncio
async def test_non_redirect_status_with_location_is_the_final_response(monkeypatch):
    _resolve_to(monkeypatch, PUBLIC_IP)
    async with SafeFetcher() as fetcher, respx.mock:
        respx.get(f"http://{PUBLIC_IP}/").mock(
            return_value=httpx.Response(
                200, headers={"location": "/not-a-redirect"}, text="body"
            )
        )
        result = await fetcher.fetch("http://example.com/")
    assert result.status == 200
    assert result.content == b"body"
    assert result.redirect_count == 0


@pytest.mark.asyncio
async def test_repeated_set_cookie_headers_are_not_collapsed(monkeypatch):
    # A dict[str, str] would keep only the last Set-Cookie, silently losing
    # cookies — and the cookies module cannot show a target's cookie surface
    # with two of the three cookies thrown away.
    _resolve_to(monkeypatch, PUBLIC_IP)
    async with SafeFetcher() as fetcher, respx.mock:
        respx.get(f"http://{PUBLIC_IP}/").mock(
            return_value=httpx.Response(
                200,
                headers=[
                    ("set-cookie", "a=1; Path=/"),
                    ("set-cookie", "b=2; Path=/"),
                ],
            )
        )
        result = await fetcher.fetch("http://example.com/")

    assert result.headers.get_list("set-cookie") == ["a=1; Path=/", "b=2; Path=/"]


@pytest.mark.asyncio
async def test_non_ascii_body_decodes_without_raising(monkeypatch):
    _resolve_to(monkeypatch, PUBLIC_IP)
    async with SafeFetcher() as fetcher, respx.mock:
        respx.get(f"http://{PUBLIC_IP}/").mock(
            return_value=httpx.Response(200, content=b"\xff\xfe\x00broken")
        )
        result = await fetcher.fetch("http://example.com/")
    assert isinstance(result.text(), str)
