"""Liveness, readiness and per-source status.

`/health` and `/ready` are deliberately unauthenticated and stay that way: a
load balancer, a keep-alive ping and a platform health check all call them
without a session, and locking them would turn a probe into a 401 alarm.

`/health/sources` is the one endpoint here that is gated, for two reasons:
probing costs upstream requests (an NVD query and a WHOIS lookup among them),
so an unauthenticated trigger would be an outbound-cost oracle; and the probe
is cached behind a TTL anyway, which means an authenticated caller loses
nothing. It follows the same `require_user()` gate every scan/history/analysis
endpoint uses (AGENTS.md §5.2).
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.core.config import settings
from app.core.rate_limit import check_free_rate_limit
from app.core.security import require_user
from app.schemas.common import error_responses
from app.schemas.health import (
    HealthResponse,
    ReadyResponse,
    SourceHealthResponse,
)
from app.services import source_health_service

router = APIRouter(tags=["health"])

SOURCES_ERROR_RESPONSES = error_responses(401, 422, 429, 503)


@router.get(
    "/health",
    response_model=HealthResponse,
    summary="Liveness",
    description=(
        "The process is up. No database, no source, no probe — this is the "
        "endpoint a keep-alive ping and a platform health check should call."
    ),
)
async def health() -> HealthResponse:
    return HealthResponse(status="ok")


@router.get(
    "/ready",
    response_model=ReadyResponse,
    summary="Readiness",
    description=(
        "Liveness plus a database round trip. `degraded` means the database "
        "ping failed; the reason itself is only exposed outside production."
    ),
)
async def ready() -> ReadyResponse:
    from app.db.session import engine

    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        return ReadyResponse(status="ready")
    except SQLAlchemyError as e:
        # Exception class names are internal detail — only expose them outside
        # production for debugging.
        if settings.is_production:
            return ReadyResponse(status="degraded")
        return ReadyResponse(status=f"degraded: {type(e).__name__}")


@router.get(
    "/health/sources",
    response_model=SourceHealthResponse,
    responses=SOURCES_ERROR_RESPONSES,
    summary="Per-source reachability status",
    description=(
        "A cached probe of every external source this deployment uses: "
        "shodan, crt.sh, whois, nvd and dns. Statuses are `ok`, `degraded` "
        "(the source answered but signalled a problem) or `unknown` (nothing "
        "could be established — a timeout, a connection failure, or a source "
        "that is not configured). `unknown` is NOT evidence that a source is "
        "down. The result is cached for SOURCE_HEALTH_TTL_SECONDS, so "
        "`checked_at` is when the probes ran and `cached` says whether this "
        "answer came from the cache. Probes never run on the scan path."
    ),
)
async def health_sources(
    user_id: Annotated[str, Depends(require_user)],
) -> SourceHealthResponse:
    # The free bucket, not the scan quota: a status check costs no Shodan
    # credit, and it must not be able to exhaust a user's scan allowance.
    check_free_rate_limit(user_id, "health")
    payload = await source_health_service.source_status()
    return SourceHealthResponse(**payload)
