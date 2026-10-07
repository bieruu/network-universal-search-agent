"""Alembic env (async). Autogenerate from app.models metadata."""

from __future__ import annotations

import asyncio
import os

from sqlalchemy.ext.asyncio import create_async_engine

from alembic import context
from app.db.base import Base
from app.models import finding, scan, target  # noqa: F401

config = context.config
# Fallback must match docker-compose.yml credentials (POSTGRES_USER=owner,
# POSTGRES_DB=osint) and stay on the asyncpg driver for create_async_engine().
url = os.getenv("DATABASE_URL", "postgresql+asyncpg://owner:owner@localhost:5432/osint")
target_metadata = Base.metadata


def include_object(
    obj: object,
    name: str,
    type_: str,
    reflected: bool,
    compare_to: object | None,
) -> bool:
    return not (type_ == "table" and reflected and compare_to is None)


def run_migrations_offline() -> None:
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        include_object=include_object,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    def do_run_migrations(connection) -> None:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            include_object=include_object,
        )
        with context.begin_transaction():
            context.run_migrations()

    async def run_async_migrations() -> None:
        engine = create_async_engine(url)
        try:
            async with engine.connect() as connection:
                await connection.run_sync(do_run_migrations)
        finally:
            await engine.dispose()

    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
