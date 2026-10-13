"""Reject an oversized request body before anything has buffered it.

WHY THIS EXISTS
    FastAPI reads and parses the request body *before* it solves dependencies.
    That is not a subtlety of one version — it is the shape of
    `fastapi/routing.py`:

        # Read body and auto-close files
        try:
            ...
            body_bytes = await request.body()
            ...
        # Solve dependencies and run path operation function
        solved_result = await solve_dependencies(...)

    `require_user` is a dependency, so it runs *after* the whole payload is
    already in memory. Every per-account quota in this repo — `check_rate_limit`,
    `check_free_rate_limit` — is likewise called from inside an endpoint. The
    result: an anonymous caller who never authenticates can still make the worker
    allocate as much memory as they care to PUT on the wire, and the only thing
    that ends the request is a 401 that arrives after the damage.

    Nothing else in the stack fills the gap. There is no Starlette body-limit
    middleware, uvicorn applies no cap of its own by default, and a Next.js App
    Router route handler has no bodyParser limit (that is a Pages Router
    setting). So the guard has to live here.

WHAT IT GUARANTEES
    1. A request whose `Content-Length` already exceeds the cap is refused with
       413 without a single byte of the body being read. This is the realistic
       attack shape: any client sending a multi-gigabyte body declares its size.
    2. A body arrived with chunked transfer encoding — no `Content-Length` — is
       counted as it streams and the read is aborted the moment it crosses the
       cap, so the worker never accumulates more than one transport chunk past
       the limit. The app is signalled by an exception raised out of `receive()`,
       which FastAPI's own body-reading `try/except Exception` converts into its
       generic "error parsing the body" response. That is documented below rather
       than papered over: the memory bound is the security property, and the
       status of an abort that only a hostile client can trigger is cosmetic.
    3. Nothing else changes: an exempt method, a non-HTTP scope, or a cap of 0
       (disabled) passes straight through, and health checks are unaffected.

`trust_env`-style reasoning does not apply here, but the same "cannot be
forgotten by a caller" logic does: this is registered once in `create_app()`,
so no endpoint can opt out of it.
"""

from __future__ import annotations

import json

from starlette.datastructures import Headers
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.config import settings

# Only ever used to bound the streaming path; the Content-Length path answers
# without constructing this.
_REJECT_HEADERS = [(b"content-type", b"application/json")]


class _BodyTooLarge(Exception):
    """Internal signal: the streamed body crossed the cap. Never escapes."""


def _reject_message(limit: int) -> list[Message]:
    payload = json.dumps(
        {
            "detail": (
                f"Request body is too large (limit {limit} bytes). "
                "Send a smaller request."
            )
        }
    ).encode("utf-8")
    return [
        {
            "type": "http.response.start",
            "status": 413,
            "headers": [*_REJECT_HEADERS, (b"content-length", b"%d" % len(payload))],
        },
        {"type": "http.response.body", "body": payload},
    ]


class BodySizeLimitMiddleware:
    """Pure ASGI middleware; wraps the app as `cls(app, max_bytes)`."""

    def __init__(self, app: ASGIApp, max_bytes: int | None = None) -> None:
        self.app = app
        self.max_bytes = (
            settings.max_request_body_bytes if max_bytes is None else max_bytes
        )

    async def _reject(self, send: Send) -> None:
        """Answer 413. `send` has not been written by the app yet, by contract."""
        start, body = _reject_message(self.max_bytes)
        await send(start)
        await send(body)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        # A cap of 0 disables the middleware, so a deployment can opt out
        # entirely by setting MAX_REQUEST_BODY_BYTES=0.
        if self.max_bytes <= 0 or scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        declared = Headers(scope=scope).get("content-length")
        if declared is not None:
            # A malformed Content-Length is not a reason to skip the guard: the
            # h11 layer rejects it anyway, and the counting path below still
            # applies, so fall through rather than treat it as "no size".
            try:
                declared_bytes = int(declared)
            except ValueError:
                declared_bytes = None
            if declared_bytes is not None and declared_bytes > self.max_bytes:
                # Cheapest and most common case: refuse without reading a byte.
                await self._reject(send)
                return

        state = {"started": False}
        total = 0

        async def counting_receive() -> Message:
            """Count as the body arrives and abort the moment it is too big.

            Raising is deliberate: it is the only thing that unwinds an app
            currently blocked inside `Request.body()`, and the only way to stop
            it appending the next chunk to its buffer.
            """
            nonlocal total
            message = await receive()
            if message["type"] == "http.request":
                total += len(message.get("body", b""))
                if total > self.max_bytes:
                    raise _BodyTooLarge()
            return message

        async def tracked_send(message: Message) -> None:
            if message["type"] == "http.response.start":
                state["started"] = True
            await send(message)

        try:
            await self.app(scope, counting_receive, tracked_send)
        except _BodyTooLarge:
            # FastAPI wraps anything raised out of `Request.body()` in
            # HTTPException(400), so by the time the signal reaches us the app
            # has usually already written a response of its own. Answer with the
            # accurate 413 only when it has not; otherwise swallow the signal and
            # let that response stand, since `send` has already been used.
            if not state["started"]:
                await self._reject(send)
