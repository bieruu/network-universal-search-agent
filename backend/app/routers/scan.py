from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.rate_limit import check_guest_rate_limit, check_rate_limit
from app.core.security import (
    assert_resolved_target_allowed,
    assert_target_allowed,
    require_user_or_guest,
)
from app.db.session import get_session
from app.models.scan import Scan
from app.models.target import Target
from app.schemas.common import error_responses
from app.schemas.scan import ScanAcceptedResponse, ScanDetailResponse, ScanRequest
from app.services import orchestrator

router = APIRouter(prefix="/api/v1", tags=["scan"])

# Documented rather than left to the generated default: the 429 is a quota
# decision (per-account hourly, instance daily, or the live-key ceiling) and
# the 422 is FastAPI's request validation, whose body is a list, not the
# `{"detail": str}` every other error uses.
SCAN_ERROR_RESPONSES = error_responses(400, 401, 422, 429, 503)
SCAN_GET_ERROR_RESPONSES = error_responses(401, 404, 429, 503)


async def _persist(
    scan_id: str, target: str, user_id: str, payload: dict, session: AsyncSession
) -> None:
    ttype = (
        "ip"
        if len(target.split(".")) == 4 and all(p.isdigit() for p in target.split("."))
        else "domain"
    )
    res = await session.execute(select(Target).where(Target.value == target.lower()))
    tgt = res.scalar_one_or_none()
    if tgt is None:
        tgt = Target(value=target.lower(), type=ttype)
        session.add(tgt)
        await session.flush()
    tgt.last_scan_at = datetime.now(timezone.utc)
    session.add(
        Scan(
            id=scan_id,
            target_id=tgt.id,
            user_id=user_id,
            status=payload["status"],
            risk_score=payload["risk_score"],
            result_snapshot=payload["results"],
            errors=payload["errors"],
            completed_at=datetime.now(timezone.utc),
        )
    )
    await session.commit()


@router.post(
    "/scan",
    response_model=ScanAcceptedResponse,
    responses=SCAN_ERROR_RESPONSES,
    summary="Start a scan",
    description=(
        "Runs the scan's sources (Shodan, crt.sh with its passive fallbacks, "
        "WHOIS, DNS, then NVD enrichment) and stores the result against your "
        "account. Returns as soon as the scan is accepted — poll "
        "`GET /api/v1/scan/{scan_id}` for the payload. A source that fails "
        "does not fail the scan: the response is HTTP 200 with an entry in "
        "`errors[]` and a `partial` status. "
        "Signed out, a guest session (`X-Guest-Token`, minted by the web app) "
        "is admitted with a small daily quota: `guest_scan_limit_per_day` per "
        "guest plus an instance-wide budget no cookie can reset. History, "
        "trend and analysis stay account-only."
    ),
)
async def post_scan(
    body: ScanRequest,
    user_id: Annotated[str, Depends(require_user_or_guest)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ScanAcceptedResponse:
    assert_target_allowed(body.target)
    # Guest and account quotas are different windows (24h vs 1h) over different
    # budgets, so they are different functions rather than a flag on one —
    # same reasoning as check_free_rate_limit vs check_rate_limit.
    if user_id.startswith("guest:"):
        check_guest_rate_limit(user_id)
    else:
        check_rate_limit(user_id)
    # The resolved-IP check runs after the rate limit on purpose: it costs a DNS
    # query, and it has to happen here rather than in a source service because
    # the orchestrator folds every source exception into errors[] (HTTP 200).
    # It hands back the IP it resolved so the Shodan source can reuse it instead
    # of resolving the same name a second time; None means "resolve it yourself",
    # which is what an unresolvable name leaves behind.
    resolved_ip = await assert_resolved_target_allowed(body.target)
    payload = await orchestrator.run_scan(
        body.target.lower(),
        user_id,
        force=body.force,
        persist=lambda **kw: _persist(session=session, **kw),
        resolved_ip=resolved_ip,
    )
    return ScanAcceptedResponse(scan_id=payload["scan_id"], status=payload["status"])


@router.get(
    "/scan/{scan_id}",
    response_model=ScanDetailResponse,
    responses=SCAN_GET_ERROR_RESPONSES,
    summary="Read one stored scan",
    description=(
        "The full stored snapshot for a scan you own: per-source results, the "
        "risk score, and the per-source errors. Results are immutable — a "
        "re-scan writes a new scan rather than editing this one. Ownership is "
        "the subject: an account reads `user:<id>` rows, a guest reads only "
        "the rows written under its own `guest:<id>`."
    ),
)
async def get_scan(
    scan_id: str,
    user_id: Annotated[str, Depends(require_user_or_guest)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ScanDetailResponse:
    scan = (
        await session.execute(
            select(Scan).where(Scan.id == scan_id, Scan.user_id == user_id)
        )
    ).scalar_one_or_none()
    if scan is None:
        raise HTTPException(status_code=404, detail="Scan not found")
    tgt = await session.get(Target, scan.target_id)
    return ScanDetailResponse(
        scan_id=scan.id,
        target=tgt.value if tgt else "",
        status=scan.status,
        risk_score=scan.risk_score,
        results=scan.result_snapshot or {},
        errors=scan.errors or [],
    )
