from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import require_user
from app.db.session import get_session
from app.models.scan import Scan
from app.models.target import Target
from app.schemas.common import error_responses
from app.schemas.history import HistoryResponse, TrendResponse

router = APIRouter(prefix="/api/v1", tags=["history"])

HISTORY_ERROR_RESPONSES = error_responses(401, 422, 429, 503)


@router.get(
    "/history",
    response_model=HistoryResponse,
    responses=HISTORY_ERROR_RESPONSES,
    summary="List your scans",
    description=(
        "The scans stored against your account, newest first, optionally "
        "filtered to one target. Scans are immutable, so a re-scan appears as "
        "a new item rather than replacing the old one."
    ),
)
async def history(
    user_id: Annotated[str, Depends(require_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    target: str | None = Query(default=None, description="Filter to one target."),
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=20, ge=1, le=100),
) -> HistoryResponse:
    stmt = (
        select(Scan, Target.value)
        .join(Target, Target.id == Scan.target_id)
        .where(Scan.user_id == user_id)
        .order_by(desc(Scan.created_at))
    )
    if target:
        stmt = stmt.where(Target.value == target.lower())
    total = (
        await session.execute(select(func.count()).select_from(stmt.subquery()))
    ).scalar() or 0
    rows = (await session.execute(stmt.offset((page - 1) * limit).limit(limit))).all()
    items = [
        {
            "scan_id": s.id,
            "target": v,
            "status": s.status,
            "risk_score": s.risk_score,
            "created_at": s.created_at.isoformat() if s.created_at else None,
        }
        for s, v in rows
    ]
    return HistoryResponse(items=items, total=total, page=page, limit=limit)


@router.get(
    "/target/{t}/trend",
    response_model=TrendResponse,
    responses=HISTORY_ERROR_RESPONSES,
    summary="Risk score trend for one target",
    description=(
        "Up to the ten most recent scans for one of your targets, oldest point "
        "first — the series the dashboard trend chart renders."
    ),
)
async def trend(
    t: str,
    user_id: Annotated[str, Depends(require_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> TrendResponse:
    _ = user_id
    stmt = (
        select(Scan)
        .join(Target, Target.id == Scan.target_id)
        .where(Scan.user_id == user_id, Target.value == t.lower())
        .order_by(desc(Scan.created_at))
        .limit(10)
    )
    scans = (await session.execute(stmt)).scalars().all()
    points = [
        {
            "scan_id": s.id,
            "created_at": s.created_at.isoformat() if s.created_at else None,
            "risk_score": s.risk_score,
        }
        for s in reversed(scans)
    ]
    return TrendResponse(target=t.lower(), points=points)
