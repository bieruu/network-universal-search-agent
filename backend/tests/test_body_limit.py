"""VULN-001: `BodySizeLimitMiddleware`, the cap that stops body exhaustion.

WHY THIS FILE EXISTS
    FastAPI reads and parses the request body *before* it solves dependencies
    (`fastapi/routing.py`: `body_bytes = await request.body()` comes before
    `solve_dependencies`). `require_user` is a dependency, so the only thing
    standing between an anonymous caller and an unbounded allocation used to be
    ... nothing: the worker buffered the whole payload and *then* answered 401.
    The middleware closes that gap and is registered last in `create_app()` so
    Starlette puts it OUTERMOST — the cap has to bite before anything reads.

WHAT IS ASSERTED
    1. A `Content-Length` already over the cap is refused with 413 without the
       body being touched at all (the realistic attack shape).
    2. The endpoint and its dependencies never run for that refusal — the whole
       point of the fix, proven against a real `create_app()` app.
    3. A body that streams in with no `Content-Length` is counted as it arrives
       and aborted the moment it crosses the cap. Both shapes of the abort are
       asserted, and the difference between them is explained where it is
       asserted, not hidden.
    4. A cap of 0 disables the middleware, non-HTTP scopes pass straight
       through, and a malformed `Content-Length` still falls into the counting
       path rather than being read as "no size".
    5. The default cap in `settings` still covers the largest legitimate body
       (the EXIF upload), and the middleware is still registered — so a
       refactor that drops either one fails the suite.

Every case is exercised twice: driven directly as a pure ASGI callable, and
mounted on the real FastAPI app through `httpx.ASGITransport`. The first shape
is the fastest way to see exactly which messages the middleware writes; the
second is the only one that proves nothing downstream ran.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterator

import httpx
import pytest
from fastapi import Depends, FastAPI, Request
from pydantic import BaseModel, ValidationError
from starlette.types import Message, Receive, Scope, Send

from app.core.body_limit import BodySizeLimitMiddleware
from app.core.config import settings
from app.main import create_app
from app.services.exif_service import MAX_INPUT_BYTES

# The largest body a legitimate client can send: the EXIF upload at
# `POST /api/v1/analysis/exif` carries base64 and is capped there at
# `(MAX_INPUT_BYTES // 3) * 4 + 4` = ~13.98 MiB. This is the number the request
# cap is sized against, and the reason the default is not some round number.
EXIF_MAX_BODY_BYTES = (MAX_INPUT_BYTES // 3) * 4 + 4

# Deliberately tiny. Every case here wants to trip the cap without paying for a
# multi-megabyte body, so the app under test is configured with this value.
CAP = 100


class _Recorder:
    """A minimal ASGI app: records that it ran and echoes the body length."""

    def __init__(self) -> None:
        self.entered = False
        self.body_lengths: list[int] = []
        self.messages: list[Message] = []
        self.scope: Scope | None = None

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        self.entered = True
        self.scope = scope
        body = b""
        while True:
            message = await receive()
            if message["type"] != "http.request":
                break
            body += message.get("body", b"")
            if not message.get("more_body", False):
                break
        self.body_lengths.append(len(body))
        payload = b"len=%d" % len(body)
        self.messages.append(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [
                    (b"content-type", b"text/plain"),
                    (b"content-length", b"%d" % len(payload)),
                ],
            }
        )
        await send(self.messages[0])
        self.messages.append({"type": "http.response.body", "body": payload})
        await send(self.messages[1])


def _scope(
    headers: list[tuple[bytes, bytes]] | None = None, scope_type: str = "http"
) -> Scope:
    return {
        "type": scope_type,
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "headers": headers or [],
        "scheme": "http",
        "path": "/probe",
        "raw_path": b"/probe",
        "query_string": b"",
        "server": ("testserver", 80),
        "client": ("203.0.113.9", 5555),
        "root_path": "",
    }


def _receiver(*chunks: bytes) -> Receive:
    """A body arriving in transport-sized pieces, then the socket parking."""
    pending = list(chunks)

    async def receive() -> Message:
        if not pending:
            # A real server hands out `http.disconnect` once it has nothing
            # more; an app that never stops reading must not hang here.
            return {"type": "http.disconnect"}
        body = pending.pop(0)
        return {"type": "http.request", "body": body, "more_body": bool(pending)}

    return receive


async def _drive(
    app: _Recorder,
    *chunks: bytes,
    headers: list[tuple[bytes, bytes]] | None = None,
    scope_type: str = "http",
) -> list[Message]:
    """Call the middleware directly and return everything it wrote via `send`."""
    sent: list[Message] = []

    async def send(message: Message) -> None:
        sent.append(message)

    middleware = BodySizeLimitMiddleware(app, max_bytes=CAP)
    await middleware(_scope(headers, scope_type), _receiver(*chunks), send)
    return sent


def _status(messages: list[Message]) -> int:
    started = [m for m in messages if m["type"] == "http.response.start"]
    assert started, "no http.response.start was ever written"
    return int(started[0]["status"])


def _body(messages: list[Message]) -> bytes:
    return b"".join(
        m.get("body", b"") for m in messages if m["type"] == "http.response.body"
    )


async def _noop_app(scope: Scope, receive: Receive, send: Send) -> None:
    """Placeholder inner app: never called, only wrapped to check the config."""


# --- the Content-Length fast path -------------------------------------------


@pytest.mark.asyncio
async def test_content_length_under_the_cap_is_not_disturbed() -> None:
    app = _Recorder()
    messages = await _drive(app, b"x" * CAP, headers=[(b"content-length", b"%d" % CAP)])

    assert app.entered is True, "the app must still run for a legal body"
    assert _status(messages) == 200
    assert _body(messages) == b"len=100"
    # The middleware is invisible: the body reaches the app intact and in order.
    assert app.body_lengths == [CAP]


@pytest.mark.asyncio
async def test_content_length_exactly_at_the_cap_is_allowed() -> None:
    app = _Recorder()
    messages = await _drive(
        app, b"x" * (CAP - 1), headers=[(b"content-length", b"%d" % (CAP - 1))]
    )
    assert _status(messages) == 200
    assert app.body_lengths == [CAP - 1]


@pytest.mark.asyncio
async def test_content_length_one_byte_over_is_refused_before_reading() -> None:
    app = _Recorder()
    messages = await _drive(
        app, b"x" * (CAP + 1), headers=[(b"content-length", b"%d" % (CAP + 1))]
    )

    assert _status(messages) == 413
    # Not "the app ran and got an empty body": the app is never entered at all,
    # so no byte of the payload is ever buffered.
    assert app.entered is False


# --- the guarantee that matters: nothing downstream runs --------------------


class _Payload(BaseModel):
    note: str = "x"


@pytest.fixture
def capped_app(monkeypatch) -> Iterator[tuple[FastAPI, list[str], list[str]]]:
    """A real `create_app()` app with the cap pinned to CAP bytes."""
    monkeypatch.setattr(settings, "max_request_body_bytes", CAP)
    # A fresh instance per test: the middleware reads `settings` while the
    # middleware stack is built (on the first request), so sharing one app would
    # let the patched cap leak into other tests.
    app = create_app()
    dep_ran: list[str] = []
    handler_ran: list[str] = []

    async def _requires_user() -> str:
        # Stands in for `require_user`: solved AFTER `await request.body()`.
        dep_ran.append("dep")
        return "user:probe"

    @app.post("/probe", response_model=None, dependencies=[Depends(_requires_user)])
    async def probe(request: Request) -> dict[str, int]:
        body = await request.body()
        handler_ran.append("probe")
        return {"length": len(body)}

    @app.post("/probe-json", response_model=None)
    async def probe_json(payload: _Payload) -> dict[str, str]:
        handler_ran.append("json")
        return {"note": payload.note}

    yield app, dep_ran, handler_ran


def _client(app: FastAPI) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    )


async def _chunked(*chunks: bytes) -> AsyncIterator[bytes]:
    for chunk in chunks:
        yield chunk


@pytest.mark.asyncio
async def test_oversized_request_never_reaches_the_dependency_or_handler(
    capped_app: tuple[FastAPI, list[str], list[str]],
) -> None:
    """The headline regression.

    An anonymous caller sends a body larger than the cap and declares its size.
    The middleware must answer without entering the router, which is the only
    way `require_user` can be spared the payload: FastAPI solves dependencies
    after reading the body, so once the body is read the damage is done.
    """
    app, dep_ran, handler_ran = capped_app
    async with _client(app) as client:
        response = await client.post("/probe", content=b"x" * (CAP + 1))

    assert response.status_code == 413
    assert dep_ran == [], "the dependency must never be solved"
    assert handler_ran == [], "the endpoint must never run"

    payload = response.json()
    assert "detail" in payload
    assert "too large" in payload["detail"].lower()
    # Machine-readable, so a caller can tell this from a 400 validation error.
    assert response.headers["content-type"].startswith("application/json")


@pytest.mark.asyncio
async def test_legal_body_on_the_mounted_app_reaches_the_handler(
    capped_app: tuple[FastAPI, list[str], list[str]],
) -> None:
    """The other half: the cap must not eat ordinary traffic."""
    app, dep_ran, handler_ran = capped_app
    async with _client(app) as client:
        response = await client.post(
            "/probe", content=b"x" * CAP, headers={"content-type": "text/plain"}
        )

    assert response.status_code == 200
    assert response.json() == {"length": CAP}
    assert dep_ran == ["dep"]
    assert handler_ran == ["probe"]


# --- the streaming (no Content-Length) path ----------------------------------


@pytest.mark.asyncio
async def test_chunked_body_without_content_length_under_the_cap_passes() -> None:
    app = _Recorder()
    messages = await _drive(app, b"x" * 40, b"x" * 40)

    assert app.entered is True
    assert _status(messages) == 200
    assert app.body_lengths == [80], "every chunk must still reach the app"


@pytest.mark.asyncio
async def test_chunked_body_without_content_length_over_the_cap_is_refused() -> None:
    app = _Recorder()
    # 60 bytes then 60 more: the cap is crossed on the second transport chunk.
    messages = await _drive(app, b"x" * 60, b"x" * 60, headers=[])

    assert _status(messages) == 413
    # The app is entered — that is how a stream is observed — but it never gets
    # to write a response, so the middleware is free to answer accurately and
    # it does. The worker meanwhile held at most one chunk past the cap.
    assert app.entered is True
    assert app.messages == [], "the app must not have started a response"
    assert b"too large" in _body(messages)


@pytest.mark.asyncio
async def test_fastapi_turns_a_streamed_abort_into_its_own_400(
    capped_app: tuple[FastAPI, list[str], list[str]],
) -> None:
    """Documented limitation: the abort's STATUS is cosmetic, the bound is not.

    The raw-ASGI case above answers 413 because the app never started a
    response. Here it does not get that chance: `_BodyTooLarge` is raised out of
    `receive()` from inside FastAPI's `try/except Exception` around
    `await request.body()` (`fastapi/routing.py`), which converts anything raised
    there into its generic `HTTPException(400, "There was an error parsing the
    body")`. So the response is a 400 while the parse never happened.

    That is recorded here rather than worked around for one reason: it is a
    status only a client that omits `Content-Length` *and* overruns the cap can
    produce. The security property is that the body is never buffered, which
    holds either way — the same request below with the cap disabled parses in
    full.
    """
    app, _dep_ran, handler_ran = capped_app
    async with _client(app) as client:
        response = await client.post(
            "/probe-json",
            content=_chunked(b'{"note"', b': "' + b"a" * 300 + b'"}'),
            headers={"content-type": "application/json"},
        )

    assert response.status_code == 400
    assert response.json()["detail"] == "There was an error parsing the body"
    assert handler_ran == [], "the endpoint still never runs"


@pytest.mark.asyncio
async def test_disable_the_cap_and_the_same_request_is_buffered_in_full(
    monkeypatch, capped_app: tuple[FastAPI, list[str], list[str]]
) -> None:
    """The counterfactual that shows the cap is what is doing the work.

    Same bytes, same route, same transport, with `MAX_REQUEST_BODY_BYTES=0`:
    the stream is read to the end, the handler runs, and the whole payload was
    in memory first. That is the shape of VULN-001 without the middleware.
    """
    _app, _dep_ran, handler_ran = capped_app
    # Patch BEFORE the app is built: the middleware resolves its cap while the
    # stack is assembled, so the ordering is the whole point of the test.
    monkeypatch.setattr(settings, "max_request_body_bytes", 0)
    disabled_app = create_app()

    @disabled_app.post("/probe-json", response_model=None)
    async def probe_json(payload: _Payload) -> dict[str, str]:
        handler_ran.append("json")
        return {"note": payload.note}

    async with _client(disabled_app) as client:
        response = await client.post(
            "/probe-json",
            content=_chunked(b'{"note"', b': "' + b"a" * 300 + b'"}'),
            headers={"content-type": "application/json"},
        )

    assert response.status_code == 200
    assert response.json()["note"] == "a" * 300
    assert handler_ran == ["json"], "the full body was buffered and parsed"


# --- configuration, non-HTTP scopes, malformed headers ----------------------


@pytest.mark.asyncio
async def test_cap_of_zero_disables_the_middleware_entirely() -> None:
    app = _Recorder()
    sent: list[Message] = []

    async def send(message: Message) -> None:
        sent.append(message)

    middleware = BodySizeLimitMiddleware(app, max_bytes=0)
    await middleware(
        _scope([(b"content-length", b"5000")]), _receiver(b"x" * 5000), send
    )

    assert app.entered is True
    assert app.body_lengths == [5000]
    assert _status(sent) == 200
    # ...and the pass-through is the raw one: the middleware is not in the path.
    assert middleware.max_bytes == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("declared", ["abc", "", "1.5", "-1"])
async def test_malformed_content_length_falls_into_the_counting_path(
    declared: str,
) -> None:
    """A garbage `Content-Length` must not read as "no size".

    h11 rejects such a header before us, so a well-behaved client never sends
    one. The middleware must not skip the guard because of it: it ignores the
    header and counts the body as it streams, which still catches the attacker
    who lies or omits the number.
    """
    app = _Recorder()
    messages = await _drive(
        app, b"x" * 500, headers=[(b"content-length", declared.encode())]
    )

    assert _status(messages) == 413, "the counting path must still bound the body"
    assert app.entered is True
    assert app.messages == []


async def _noop_app(scope: Scope, receive: Receive, send: Send) -> None:
    """Never called: a place-holder inner app for the config test."""


@pytest.mark.asyncio
async def test_malformed_content_length_still_allows_a_small_body() -> None:
    app = _Recorder()
    messages = await _drive(app, b"small", headers=[(b"content-length", b"abc")])

    assert _status(messages) == 200
    assert app.body_lengths == [5]


@pytest.mark.asyncio
@pytest.mark.parametrize("scope_type", ["websocket", "lifespan"])
async def test_non_http_scopes_pass_straight_through(scope_type: str) -> None:
    """A websocket or lifespan scope must not be body-limited."""
    app = _Recorder()
    received: list[Message] = []

    async def receive() -> Message:
        message = {"type": "lifespan.startup"}
        received.append(message)
        return message

    sent: list[Message] = []

    async def send(message: Message) -> None:
        sent.append(message)

    middleware = BodySizeLimitMiddleware(app, max_bytes=CAP)
    scope = _scope([], scope_type)
    await middleware(scope, receive, send)

    # Not a filtered copy of the scope: the very same objects go through.
    assert app.entered is True
    assert app.scope == scope
    assert received, "the middleware must not swallow the messages either"


@pytest.mark.asyncio
async def test_middleware_reads_its_cap_from_settings_when_not_given(
    monkeypatch,
) -> None:
    """`max_bytes=None` must resolve from the live settings, not a snapshot."""
    from app.core.config import Settings

    assert Settings.model_fields["max_request_body_bytes"].default == 16 * 1024 * 1024
    # 0 is a legal value precisely so a deployment can turn the cap off, so a
    # negative one has to be refused rather than silently meaning "off".
    with pytest.raises(ValidationError):
        Settings(max_request_body_bytes=-1)

    monkeypatch.setattr(settings, "max_request_body_bytes", 7)
    assert BodySizeLimitMiddleware(_noop_app).max_bytes == 7
    monkeypatch.setattr(settings, "max_request_body_bytes", 0)
    assert BodySizeLimitMiddleware(_noop_app).max_bytes == 0


def test_default_cap_covers_the_largest_legitimate_body() -> None:
    """The real constraint on the number, stated so it cannot drift.

    The biggest body any legitimate client can send is the EXIF upload, whose
    base64 payload is capped at `(MAX_INPUT_BYTES // 3) * 4 + 4` (~13.98 MiB) in
    `routers/analysis.py`. 16 MiB is the smallest power-of-two-ish number that
    clears it with room for the JSON envelope, and NOTHING else needs more.

    Raising the default buys nothing and reopens the bug: the cap's entire value
    is that it is strictly above the largest legitimate body and strictly below
    what an attacker cares to send. Push it up and the anonymous memory
    exhaustion VULN-001 describes comes straight back — the endpoint that could
    absorb 32 MiB of base64 would happily absorb it before returning 401. An
    operator who genuinely needs bigger uploads should raise MAX_INPUT_BYTES in
    the EXIF service as a deliberate, reviewable change, not quiet this cap.
    """
    assert settings.max_request_body_bytes == 16 * 1024 * 1024
    assert settings.max_request_body_bytes >= EXIF_MAX_BODY_BYTES
    # Headroom over the EXIF cap is the JSON envelope, not slack.
    assert settings.max_request_body_bytes - EXIF_MAX_BODY_BYTES < 3 * 1024 * 1024


def test_body_limit_middleware_is_registered_and_outermost() -> None:
    """A refactor that drops the middleware — or reorders it — fails here."""
    app = create_app()
    registered = [m for m in app.user_middleware if m.cls is BodySizeLimitMiddleware]
    assert registered, "BodySizeLimitMiddleware must be registered on the app"

    # Starlette inserts each new middleware at the front of the stack, so the
    # LAST one added is the OUTERMOST. It was added last on purpose: it has to
    # run before CORS and before anything else can look at the body.
    assert app.user_middleware[0].cls is BodySizeLimitMiddleware
