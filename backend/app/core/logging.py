"""structlog JSON logging + X-Request-ID middleware."""
from __future__ import annotations

import time
import uuid
from contextvars import ContextVar

import structlog
from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware

request_id_ctx: ContextVar[str] = ContextVar("request_id", default="-")

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
        rid = request.headers.get("X-Request-ID") or uuid.uuid4().hex[:12]
        request_id_ctx.set(rid)
        structlog.contextvars.bind_contextvars(request_id=rid)
        start = time.perf_counter()
        try:
            response = await call_next(request)
        finally:
            structlog.contextvars.unbind_contextvars("request_id")
        elapsed_ms = int((time.perf_counter() - start) * 1000)
        response.headers["X-Request-ID"] = rid
        logger.info("request", path=request.url.path, method=request.method, latency_ms=elapsed_ms)
        return response
