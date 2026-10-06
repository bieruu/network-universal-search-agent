from fastapi import APIRouter
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.core.config import settings

router = APIRouter()


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/ready")
async def ready() -> dict[str, str]:
    from app.db.session import engine

    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        return {"status": "ready"}
    except SQLAlchemyError as e:
        # Exception class names are internal detail — only expose them outside
        # production for debugging.
        if settings.is_production:
            return {"status": "degraded"}
        return {"status": f"degraded: {type(e).__name__}"}
