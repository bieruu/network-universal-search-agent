from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.rate_limit import check_rate_limit
from app.core.security import assert_target_allowed, require_user
from app.db.session import get_session
from app.models.scan import Scan
from app.models.target import Target
from app.schemas.scan import ScanRequest
from app.services import orchestrator

router = APIRouter(prefix="/api/v1", tags=["scan"])


async def _persist(scan_id: str, target: str, user_id: str, payload: dict, session: AsyncSession) -> None:
    ttype = "ip" if len(target.split(".")) == 4 and all(p.isdigit() for p in target.split(".")) else "domain"
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


@router.post("/scan")
async def post_scan(
    body: ScanRequest,
    user_id: str = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> dict:
    assert_target_allowed(body.target)
    check_rate_limit(user_id)
    payload = await orchestrator.run_scan(
        body.target.lower(), user_id, force=body.force, persist=lambda **kw: _persist(session=session, **kw)
    )
    return {"scan_id": payload["scan_id"], "status": payload["status"]}


@router.get("/scan/{scan_id}")
async def get_scan(
    scan_id: str, user_id: str = Depends(require_user), session: AsyncSession = Depends(get_session)
) -> dict:
    _ = user_id
    scan = await session.get(Scan, scan_id)
    if scan is None:
        raise HTTPException(status_code=404, detail="Scan not found")
    tgt = await session.get(Target, scan.target_id)
    return {
        "scan_id": scan.id,
        "target": tgt.value if tgt else "",
        "status": scan.status,
        "risk_score": scan.risk_score,
        "results": scan.result_snapshot,
        "errors": scan.errors,
    }
