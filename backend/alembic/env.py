"""Alembic env (async). Autogenerate from app.models metadata."""
from __future__ import annotations

import asyncio
import os

from alembic import context
from sqlalchemy.ext.asyncio import create_async_engine

from app.db.base import Base
from app.models import finding, scan, target  # noqa: F401

config = context.config
url = os.getenv("DATABASE_URL", "postgresql+asyncpg://osint:osint@localhost:5432/osint")
target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(url=url, target_metadata=target_metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    engine = create_async_engine(url)

    async def do_run() -> None:
        async with engine.connect() as conn:
            await conn.run_sync(
                lambda sync_conn: context.configure(connection=sync_conn, target_metadata=target_metadata)
            )
            await conn.run_sync(lambda _: context.run_migrations())

    asyncio.run(do_run())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
