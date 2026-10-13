"""structlog JSON logging + X-Request-ID middleware."""

from __future__ import annotations

import re
import time
import uuid
from contextvars import ContextVar

import structlog
from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware

request_id_ctx: ContextVar[str] = ContextVar("request_id", default="-")

# What a client-supplied X-Request-ID may look like. It is echoed into a
# response header and into the structured log, so anything outside this set is
# replaced rather than trusted.
#
# MEASURED, NOT ASSUMED: a CR/LF can never arrive here at all. h11 rejects a
# malformed header line at request-parse time with a clean 400, so an embedding
# attempt never reaches this module. What DOES arrive, and was previously
# mirrored verbatim into the response, is a value carrying a space, a tab, a
# DEL, a quoted string, markup, a latin-1 high byte, or an unbounded run of
# characters — anything that parses as one header line. Starlette's
# `MutableHeaders.__setitem__` performs no validation of that value, so it went
# straight back out on the wire and into every log line for the request.
MAX_REQUEST_ID_CHARS = 64
SAFE_REQUEST_ID_RE = re.compile(rf"\A[A-Za-z0-9_-]{{1,{MAX_REQUEST_ID_CHARS}}}\Z")


def coerce_request_id(raw: str | None) -> str:
    """Return `raw` when it is a safe correlation id, otherwise a fresh one.

    Never raises: an absent or malformed value is simply replaced. The caller
    cannot tell its own rejected value apart from ours, which is deliberate —
    the header is a debugging aid, not a channel for the client to mint. The
    12-char cap also bounds what one request can add to its own log lines.
    """
    if raw and SAFE_REQUEST_ID_RE.match(raw):
        return raw
    return uuid.uuid4().hex[:12]


structlog.configure(
    processors=[
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.JSONRenderer(),
    ]
)
logger = structlog.get_logger()


class RequestIDMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):  # type: ignore[no-untyped-def]
        rid = coerce_request_id(request.headers.get("X-Request-ID"))
        request_id_ctx.set(rid)
        structlog.contextvars.bind_contextvars(request_id=rid)
        start = time.perf_counter()
        try:
            response = await call_next(request)
        finally:
            structlog.contextvars.unbind_contextvars("request_id")
        elapsed_ms = int((time.perf_counter() - start) * 1000)
        response.headers["X-Request-ID"] = rid
        logger.info(
            "request",
            path=request.url.path,
            method=request.method,
            latency_ms=elapsed_ms,
        )
        return response
