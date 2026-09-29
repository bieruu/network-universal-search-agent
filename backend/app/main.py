from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.core.logging import RequestIDMiddleware


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    from app.db.session import init_db

    await init_db()
    yield


def create_app() -> FastAPI:
    app = FastAPI(title="OSINT Dashboard API", version="1.0.0", lifespan=lifespan)
    app.add_middleware(RequestIDMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_list,
        allow_credentials=True,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["content-type", "authorization", "x-request-id"],
    )
    from app.routers import health, history, scan

    app.include_router(health.router)
    app.include_router(scan.router)
    app.include_router(history.router)
    return app


app = create_app()
