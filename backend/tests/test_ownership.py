from datetime import datetime, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.db.base import Base
from app.models.scan import Scan
from app.models.target import Target
from app.routers.history import history, trend
from app.routers.scan import get_scan


@pytest.mark.asyncio
async def test_history_trend_and_scan_details_are_owner_scoped():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as session:
        target = Target(id="target-1", value="example.com", type="domain")
        session.add(target)
        session.add_all(
            [
                Scan(
                    id="scan-alice",
                    target_id=target.id,
                    user_id="user:alice",
                    status="completed",
                    risk_score=10,
                    result_snapshot={},
                    errors=[],
                    created_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
                ),
                Scan(
                    id="scan-bob",
                    target_id=target.id,
                    user_id="user:bob",
                    status="completed",
                    risk_score=20,
                    result_snapshot={},
                    errors=[],
                    created_at=datetime(2026, 1, 2, tzinfo=timezone.utc),
                ),
            ]
        )
        await session.commit()

        alice_history = await history(
            target="example.com",
            page=1,
            limit=20,
            user_id="user:alice",
            session=session,
        )
        assert [item["scan_id"] for item in alice_history["items"]] == ["scan-alice"]
        alice_trend = await trend(
            t="example.com", user_id="user:alice", session=session
        )
        assert [point["scan_id"] for point in alice_trend["points"]] == ["scan-alice"]
        with pytest.raises(HTTPException) as not_owner:
            await get_scan("scan-bob", user_id="user:alice", session=session)
        assert not_owner.value.status_code == 404

        bob_scan = await get_scan("scan-bob", user_id="user:bob", session=session)
        assert bob_scan["scan_id"] == "scan-bob"

    await engine.dispose()
