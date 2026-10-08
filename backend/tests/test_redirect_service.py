"""Redirect trace: the chain the guard recorded, reported hop by hop.

Two things are being defended here, and they pull in opposite directions:

  - the *policy* must still hold (a hop into a private address is refused, and
    the blocked host is never requested), and
  - the *cap* must not be an outage (a chain longer than the cap is a finding
    about the target, returned as a normal result, not a 500).

DNS is pinned and the transport is mocked on the pinned IP, so the resolver can
be told a public name points somewhere it should not, and so no test touches the
network.
"""

from __future__ import annotations

import json

import httpx
import pytest
import respx

from app.core import ssrf
from app.core.ssrf import Hop, SafeFetcher, SsrfBlocked, SsrfTimeout
from app.services import redirect_service

PUBLIC_IP = "93.184.216.34"
LOOPBACK_IP = "127.0.0.1"


def _resolve_to(monkeypatch, *addresses: str) -> None:
    """Pin every resolution to a fixed answer.

    The guard resolves before it connects and then dials the address it resolved,
    so controlling the resolver is what lets a test make a *public* name point at
    a private address — which is exactly the confusion the guard must survive.
    """
    monkeypatch.setattr(ssrf, "_sync_resolve_all", lambda host, port: list(addresses))


@pytest.mark.asyncio
async def test_chain_is_reported_hop_by_hop_with_every_status(monkeypatch):
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
        out = await redirect_service.lookup("http://example.com/", fetcher)

    assert out["source"] == "Redirect trace"
    assert out["url"] == "http://example.com/"
    assert out["final_url"] == "http://example.com/final"
    assert out["final_status"] == 200
    assert out["hop_count"] == 2
    assert out["truncated"] is False

    # The whole point of the module: per-hop status, not just the final URL.
    assert [hop["status"] for hop in out["hops"]] == [301, 302, 200]
    assert [hop["url"] for hop in out["hops"]] == [
        "http://example.com/",
        "http://example.com/next",
        "http://example.com/final",
    ]
    assert [hop["is_redirect"] for hop in out["hops"]] == [True, True, False]
    assert [hop["location"] for hop in out["hops"]] == ["/next", "/final", None]
    # The address validated and dialled for each hop, and the hostname kept
    # intact so the report is readable rather than a list of IP literals.
    assert {hop["resolved_ip"] for hop in out["hops"]} == {PUBLIC_IP}

    assert out["crosses_scheme"] is False
    assert out["downgrades_to_http"] is False
    assert out["loop_detected"] is False
    # Only findings land in notes: a two-redirect chain that ended in 200 on the
    # same host and the same scheme has nothing to report.
    assert out["notes"] == []


@pytest.mark.asyncio
async def test_non_success_final_status_is_noted(monkeypatch):
    _resolve_to(monkeypatch, PUBLIC_IP)
    async with SafeFetcher() as fetcher, respx.mock:
        respx.get(f"http://{PUBLIC_IP}/").mock(
            return_value=httpx.Response(301, headers={"location": "/gone"})
        )
        respx.get(f"http://{PUBLIC_IP}/gone").mock(
            return_value=httpx.Response(404, text="nope")
        )
        out = await redirect_service.lookup("http://example.com/", fetcher)

    assert out["final_status"] == 404
    assert out["hop_count"] == 1
    assert "final status 404" in out["notes"]


@pytest.mark.asyncio
async def test_single_200_has_no_redirects(monkeypatch):
    _resolve_to(monkeypatch, PUBLIC_IP)
    async with SafeFetcher() as fetcher, respx.mock:
        respx.get(f"http://{PUBLIC_IP}/").mock(
            return_value=httpx.Response(200, text="ok")
        )
        out = await redirect_service.lookup("http://example.com/", fetcher)

    assert out["hop_count"] == 0
    assert len(out["hops"]) == 1
    assert out["hops"][0]["is_redirect"] is False
    assert out["final_status"] == 200
    assert "no redirect; the target answered directly" in out["notes"]


@pytest.mark.asyncio
async def test_hop_cap_returns_a_truncated_result_instead_of_raising(monkeypatch):
    """A cap that raises a 500 is not a cap: this is the behaviour under test."""
    _resolve_to(monkeypatch, PUBLIC_IP)
    async with SafeFetcher(max_redirects=3) as fetcher, respx.mock:
        respx.get(f"http://{PUBLIC_IP}/").mock(
            return_value=httpx.Response(302, headers={"location": "/loop"})
        )
        respx.get(f"http://{PUBLIC_IP}/loop").mock(
            return_value=httpx.Response(302, headers={"location": "/"})
        )
        # Must not raise: the chain is a finding about the target.
        out = await redirect_service.lookup("http://example.com/", fetcher)

    assert out["truncated"] is True
    assert out["hops"] == []
    assert out["hop_count"] == 0
    assert out["final_status"] == 0
    assert out["final_url"] == ""
    assert out["crosses_scheme"] is False
    assert out["downgrades_to_http"] is False
    assert out["loop_detected"] is False
    assert any("hop cap" in note for note in out["notes"])
    # The guard's own message carries the real cap, so the note cannot claim a
    # number the caller did not configure.
    assert any("3 hops" in note for note in out["notes"])
    # Honest about the empty hop list rather than implying we traced nothing.
    assert any("no hops reported" in note for note in out["notes"])
    # And it really is serialisable, which is the whole point of not raising.
    assert json.loads(json.dumps(out))["truncated"] is True


@pytest.mark.asyncio
async def test_redirect_into_a_private_address_raises_and_is_never_requested(
    monkeypatch,
):
    """The policy must survive the reporting layer: fail closed, and ask nothing."""
    answers = {"example.com": [PUBLIC_IP], "127.0.0.1": [LOOPBACK_IP]}
    monkeypatch.setattr(
        ssrf, "_sync_resolve_all", lambda host, port: answers.get(host, [PUBLIC_IP])
    )
    async with SafeFetcher() as fetcher, respx.mock:
        first_hop = respx.get(f"http://{PUBLIC_IP}/").mock(
            return_value=httpx.Response(
                301, headers={"location": f"http://{LOOPBACK_IP}/secrets"}
            )
        )
        loopback = respx.get(f"http://{LOOPBACK_IP}/secrets").mock(
            return_value=httpx.Response(200, text="SECRET")
        )
        with pytest.raises(SsrfBlocked, match="blocked address"):
            await redirect_service.lookup("http://example.com/", fetcher)

        # Hop 1 was served — the report is allowed to have started — and hop 2 was
        # never dialled, which is the guarantee that matters.
        assert first_hop.call_count == 1
        assert loopback.call_count == 0, "the blocked hop must never be requested"


@pytest.mark.asyncio
async def test_http_to_https_upgrade_sets_crosses_scheme(monkeypatch):
    _resolve_to(monkeypatch, PUBLIC_IP)
    async with SafeFetcher() as fetcher, respx.mock:
        respx.get(f"http://{PUBLIC_IP}/").mock(
            return_value=httpx.Response(
                301, headers={"location": "https://example.com/secure"}
            )
        )
        respx.get(f"https://{PUBLIC_IP}/secure").mock(
            return_value=httpx.Response(200, text="ok")
        )
        out = await redirect_service.lookup("http://example.com/", fetcher)

    assert out["crosses_scheme"] is True
    assert out["downgrades_to_http"] is False
    assert [hop["url"] for hop in out["hops"]] == [
        "http://example.com/",
        "https://example.com/secure",
    ]
    assert "chain crosses from http to https on hop 2" in out["notes"]


@pytest.mark.asyncio
async def test_https_to_http_downgrade_sets_downgrades_to_http(monkeypatch):
    _resolve_to(monkeypatch, PUBLIC_IP)
    async with SafeFetcher() as fetcher, respx.mock:
        respx.get(f"https://{PUBLIC_IP}/").mock(
            return_value=httpx.Response(
                301, headers={"location": "http://example.com/plain"}
            )
        )
        respx.get(f"http://{PUBLIC_IP}/plain").mock(
            return_value=httpx.Response(200, text="ok")
        )
        out = await redirect_service.lookup("https://example.com/", fetcher)

    assert out["downgrades_to_http"] is True
    assert out["crosses_scheme"] is True
    assert "chain crosses from https to http on hop 2" in out["notes"]


@pytest.mark.asyncio
async def test_plaintext_chain_is_not_called_a_downgrade(monkeypatch):
    """A chain that started on http and stayed there did not downgrade.

    Flagging it would tell a reader something untrue about an ordinary site, so
    the flag means "https -> http happened", not "a later hop was http".
    """
    _resolve_to(monkeypatch, PUBLIC_IP)
    async with SafeFetcher() as fetcher, respx.mock:
        respx.get(f"http://{PUBLIC_IP}/").mock(
            return_value=httpx.Response(301, headers={"location": "/next"})
        )
        respx.get(f"http://{PUBLIC_IP}/next").mock(
            return_value=httpx.Response(301, headers={"location": "/final"})
        )
        respx.get(f"http://{PUBLIC_IP}/final").mock(
            return_value=httpx.Response(200, text="ok")
        )
        out = await redirect_service.lookup("http://example.com/", fetcher)

    assert out["downgrades_to_http"] is False
    assert out["crosses_scheme"] is False


@pytest.mark.asyncio
async def test_repeated_url_sets_loop_detected(monkeypatch):
    _resolve_to(monkeypatch, PUBLIC_IP)
    async with SafeFetcher() as fetcher, respx.mock:
        # Same URL, two different answers: the first visit bounces, the second
        # ends the chain. A loop that terminates is still a loop.
        respx.get(f"http://{PUBLIC_IP}/").mock(
            side_effect=[
                httpx.Response(302, headers={"location": "/loop"}),
                httpx.Response(200, text="ok"),
            ]
        )
        respx.get(f"http://{PUBLIC_IP}/loop").mock(
            return_value=httpx.Response(302, headers={"location": "/"})
        )
        out = await redirect_service.lookup("http://example.com/", fetcher)

    assert out["loop_detected"] is True
    assert [hop["url"] for hop in out["hops"]] == [
        "http://example.com/",
        "http://example.com/loop",
        "http://example.com/",
    ]
    assert out["hop_count"] == 2
    assert any("redirect loop" in note for note in out["notes"])


@pytest.mark.asyncio
async def test_307_and_308_are_reported_per_hop(monkeypatch):
    _resolve_to(monkeypatch, PUBLIC_IP)
    async with SafeFetcher() as fetcher, respx.mock:
        respx.get(f"http://{PUBLIC_IP}/").mock(
            return_value=httpx.Response(308, headers={"location": "/moved"})
        )
        respx.get(f"http://{PUBLIC_IP}/moved").mock(
            return_value=httpx.Response(307, headers={"location": "/here"})
        )
        respx.get(f"http://{PUBLIC_IP}/here").mock(
            return_value=httpx.Response(200, text="ok")
        )
        out = await redirect_service.lookup("http://example.com/", fetcher)

    assert [hop["status"] for hop in out["hops"]] == [308, 307, 200]
    assert out["hop_count"] == 2


@pytest.mark.asyncio
async def test_redirect_onto_another_host_is_reported(monkeypatch):
    answers = {"example.com": [PUBLIC_IP], "other.test": ["8.8.8.8"]}
    monkeypatch.setattr(
        ssrf, "_sync_resolve_all", lambda host, port: answers.get(host, [PUBLIC_IP])
    )
    async with SafeFetcher() as fetcher, respx.mock:
        respx.get(f"http://{PUBLIC_IP}/").mock(
            return_value=httpx.Response(302, headers={"location": "http://other.test/"})
        )
        respx.get("http://8.8.8.8/").mock(return_value=httpx.Response(200, text="ok"))
        out = await redirect_service.lookup("http://example.com/", fetcher)

    assert out["hop_count"] == 1
    assert [hop["resolved_ip"] for hop in out["hops"]] == [PUBLIC_IP, "8.8.8.8"]
    assert any("different host" in note for note in out["notes"])


@pytest.mark.asyncio
async def test_injected_fetcher_is_left_open_for_the_caller(monkeypatch):
    _resolve_to(monkeypatch, PUBLIC_IP)
    calls: list[bool] = []
    original = SafeFetcher.aclose

    async def _tracking(self):
        calls.append(True)
        await original(self)

    monkeypatch.setattr(SafeFetcher, "aclose", _tracking)
    fetcher = SafeFetcher()
    try:
        # The route MUST be registered inside `respx.mock`: respx.get() called
        # outside it registers on the global default router and is never cleaned
        # up, leaking a route into every test file that runs afterwards.
        async with respx.mock:
            respx.get(f"http://{PUBLIC_IP}/").mock(
                return_value=httpx.Response(200, text="ok")
            )
            out = await redirect_service.lookup("http://example.com/", fetcher)
        assert out["hop_count"] == 0
        assert calls == [], "an injected fetcher belongs to the caller"
    finally:
        await original(fetcher)


@pytest.mark.asyncio
async def test_fetcher_built_here_is_closed_before_returning(monkeypatch):
    _resolve_to(monkeypatch, PUBLIC_IP)
    calls: list[bool] = []
    original = SafeFetcher.aclose

    async def _tracking(self):
        calls.append(True)
        await original(self)

    monkeypatch.setattr(SafeFetcher, "aclose", _tracking)
    async with respx.mock:
        respx.get(f"http://{PUBLIC_IP}/").mock(
            return_value=httpx.Response(200, text="ok")
        )
        out = await redirect_service.lookup("http://example.com/")

    assert out["hop_count"] == 0
    assert calls == [True]


@pytest.mark.asyncio
async def test_timeout_propagates_rather_than_being_reported(monkeypatch):
    """Only the hop cap becomes a result; a timeout is the router's error to make."""
    _resolve_to(monkeypatch, PUBLIC_IP)
    async with SafeFetcher() as fetcher, respx.mock:
        respx.get(f"http://{PUBLIC_IP}/").mock(
            side_effect=httpx.ReadTimeout("too slow")
        )
        with pytest.raises(SsrfTimeout, match="timed out"):
            await redirect_service.lookup("http://example.com/", fetcher)


def test_hop_strings_are_bounded():
    """A redirect target is attacker-chosen text, so it is bounded like a banner."""
    hop = Hop(
        url="https://example.com/" + "a" * 5000,
        status=302,
        ip="93.184.216.34",
        location="/" + "b" * 5000,
        is_redirect=True,
    )
    row = redirect_service._hop_row(hop)

    assert len(row["url"]) == redirect_service._MAX_URL_CHARS
    assert len(row["location"]) == redirect_service._MAX_LOCATION_CHARS
    assert len(row["resolved_ip"]) <= redirect_service._MAX_IP_CHARS
    assert row["is_redirect"] is True


def test_notes_are_bounded_and_say_when_they_were_dropped():
    # Alternating the scheme on every hop forces one transition note per hop,
    # which is how a chain pushes past the note cap.
    hops = tuple(
        Hop(
            url=f"{'https' if index % 2 else 'http'}://example.com/{index}",
            status=302,
            ip="93.184.216.34",
            location="/next",
            is_redirect=True,
        )
        for index in range(24)
    )

    described = redirect_service._describe(hops, 200)
    assert described["crosses_scheme"] is True

    notes = redirect_service._cap_notes(described["notes"])
    assert len(notes) == redirect_service._MAX_NOTES
    assert all(len(note) <= redirect_service._MAX_NOTE_CHARS for note in notes)
    assert "further finding(s) omitted" in notes[-1]


def test_long_note_text_is_truncated():
    notes = redirect_service._cap_notes(["x" * 5000])
    assert notes == ["x" * redirect_service._MAX_NOTE_CHARS]
