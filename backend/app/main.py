from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.core.logging import RequestIDMiddleware


def create_app() -> FastAPI:
    # Never expose schema/docs endpoints in production (they reveal the full
    # API surface to unauthenticated callers).
    docs_url = None if settings.is_production else "/docs"
    redoc_url = None if settings.is_production else "/redoc"
    openapi_url = None if settings.is_production else "/openapi.json"
    app = FastAPI(
        title="OSINT Dashboard API",
        version="1.0.0",
        docs_url=docs_url,
        redoc_url=redoc_url,
        openapi_url=openapi_url,
    )
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
