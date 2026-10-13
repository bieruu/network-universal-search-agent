"""VULN-003: a client-supplied `X-Request-ID` is coerced, never trusted.

WHY THIS FILE EXISTS
    Starlette's `MutableHeaders.__setitem__` validates nothing. Echoing a raw
    client value into a response header therefore hands any caller a header
    injection primitive: a value containing `\r\nX-Injected: 1` reached the h11
    layer as a malformed header, uvicorn logged it as an unhandled error and the
    caller got a 500 instead of their 400. `coerce_request_id()` closes that by
    REPLACING anything outside `[A-Za-z0-9_-]{1,64}` with a fresh 12-char hex id
    rather than sanitising or rejecting it, so a rejected value can never be
    mirrored back.

WHAT IS ASSERTED
    1. A safe id round-trips exactly — the debugging use must not regress.
    2. Every rejected shape is REPLACED by a fresh, well-formed id: empty, None,
       over-length, CR/LF, space, tab, `%0d%0a`, unicode, control characters, a
       value that starts out valid and then turns bad, and whitespace-only.
    3. The fallback is well-formed and not a constant, so a caller cannot force
       a predictable log field.
    4. End to end through `RequestIDMiddleware`: the exact value comes back for
       a valid id, and a malformed one comes back replaced, well-formed, with a
       200 — never a 500, never the rejected string.
    5. The id that reaches the log context (both `request_id_ctx` and the
       structlog binding) is the accepted one, so the log never records the
       attacker's string.
"""

from __future__ import annotations

from collections.abc import Iterator

import httpx
import pytest
import structlog
from fastapi import FastAPI, Request

from app.core.logging import (
    MAX_REQUEST_ID_CHARS,
    RequestIDMiddleware,
    coerce_request_id,
    request_id_ctx,
)
from app.main import create_app

VALID_ID = "abc-123_XYZ"


def _assert_well_formed(value: str) -> None:
    """The fallback: exactly 12 lowercase hex characters."""
    assert len(value) == 12
    int(value, 16)  # raises ValueError unless it really is hex
    assert value == value.lower()


# --- the pure function ------------------------------------------------------


def test_valid_id_round_trips_unchanged() -> None:
    for good in (
        VALID_ID,
        "a",
        "0",
        "-",
        "_",
        "a" * MAX_REQUEST_ID_CHARS,  # exactly at the bound
        "Bearer-Style_Id-9",
    ):
        assert coerce_request_id(good) == good


def test_boundary_is_64_accepted_65_replaced() -> None:
    at_cap = "a" * MAX_REQUEST_ID_CHARS
    assert MAX_REQUEST_ID_CHARS == 64
    assert coerce_request_id(at_cap) == at_cap

    over_cap = "a" * (MAX_REQUEST_ID_CHARS + 1)
    replaced = coerce_request_id(over_cap)
    assert replaced != over_cap, "an over-long id must be replaced, not mirrored"
    _assert_well_formed(replaced)


@pytest.mark.parametrize(
    "raw",
    [
        "",
        None,
        "a b",
        " ",
        "   ",
        "\t",
        "\r",
        "\n",
        "\r\n",
        "abc\ndef",
        "abc\r\ndef",
        "evil\r\nX-Injected: 1",
        "%0d%0a",
        "<script>alert(1)</script>",
        "caf\u00e9",
        "\u00fcid",
        "\x00",
        "id-with-\x7f-control",
        "a" * 65,
        "  " + "a" * 64,
        "trailing ",
    ],
)
def test_rejected_value_is_replaced_not_mirrored(raw: str | None) -> None:
    replaced = coerce_request_id(raw)

    if raw is not None:
        assert replaced != raw, f"{raw!r} was mirrored back unchanged"
    _assert_well_formed(replaced)


def test_fallback_is_not_a_constant() -> None:
    values = {coerce_request_id(bad) for bad in ("\r\n", "a b", "", None, "x" * 65)}
    assert len(values) > 1, "a predictable fallback is a predictable log field"
    for value in values:
        _assert_well_formed(value)

    # And it is not simply derived from the input it rejected.
    assert coerce_request_id("a" * 65) != coerce_request_id("a" * 65)


# --- end to end through RequestIDMiddleware --------------------------------


class _RidApp:
    """The app under test plus the id the log context carried for each request."""

    def __init__(self, app: FastAPI) -> None:
        self.app = app
        self.context_ids: list[str] = []
        self.log_contexts: list[dict[str, object]] = []

    def record(self) -> None:
        """Called from inside the handler, where both context vars are set."""
        self.context_ids.append(request_id_ctx.get())
        self.log_contexts.append(dict(structlog.contextvars.get_contextvars()))


@pytest.fixture
def rid_app() -> Iterator[_RidApp]:
    app = create_app()
    rid_app = _RidApp(app)

    @app.get("/probe", response_model=None)
    async def probe(request: Request) -> dict[str, str]:
        # Read at the point the middleware has already set both, so this is what
        # the structured log line for this request would carry.
        rid_app.record()
        return {"path": request.url.path}

    yield rid_app


def _client(app: FastAPI) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    )


@pytest.mark.asyncio
async def test_valid_request_id_is_echoed_verbatim(rid_app: _RidApp) -> None:
    async with _client(rid_app.app) as client:
        response = await client.get("/probe", headers={"X-Request-ID": VALID_ID})

    assert response.status_code == 200
    assert response.headers["X-Request-ID"] == VALID_ID
    # The log context carries the same accepted value, not the raw header.
    assert rid_app.context_ids == [VALID_ID]
    assert rid_app.log_contexts == [{"request_id": VALID_ID}]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "raw",
    [
        "evil\r\nX-Injected: 1",
        "a b",
        "x" * 65,
        "<script>",
        "tab\there",
        "%0d%0a",
    ],
)
async def test_malformed_request_id_is_replaced_with_a_200(
    rid_app: _RidApp, raw: str
) -> None:
    """The regression: a CR/LF in the value used to be an unhandled 500."""
    async with _client(rid_app.app) as client:
        response = await client.get("/probe", headers={"X-Request-ID": raw})

    echoed = response.headers.get("X-Request-ID", "")
    assert response.status_code == 200, "a bad id must never become a 500"
    assert echoed != raw, "the rejected value must not be mirrored back"
    _assert_well_formed(echoed)
    # ...and no injected header appeared on the response.
    assert "X-Injected" not in response.headers
    assert rid_app.context_ids == [echoed], "the log context must carry the accepted id"
    assert rid_app.log_contexts == [{"request_id": echoed}]


@pytest.mark.asyncio
async def test_request_without_the_header_gets_a_generated_id(
    rid_app: _RidApp,
) -> None:
    async with _client(rid_app.app) as client:
        response = await client.get("/probe")

    assert response.status_code == 200
    generated = response.headers["X-Request-ID"]
    _assert_well_formed(generated)
    assert rid_app.context_ids == [generated]


def test_middleware_is_registered_on_the_app() -> None:
    """The coercion only protects requests if this middleware is mounted."""
    app = create_app()
    registered = [m for m in app.user_middleware if m.cls is RequestIDMiddleware]
    assert registered, "RequestIDMiddleware must be registered on the app"
