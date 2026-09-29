"""CACHE_BACKEND flag tests: sqlite round-trip + postgres failure safety."""

from __future__ import annotations

import pytest

from app.core import cache as cache_mod
from app.core.config import settings


@pytest.mark.asyncio
async def test_sqlite_async_round_trip(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "cache_backend", "sqlite")
    monkeypatch.setattr(settings, "sqlite_path", str(tmp_path / "cache.db"))
    await cache_mod.cache_set_async(
        "shodan:example.com", {"ports": [80]}, ttl_seconds=60
    )
    assert await cache_mod.cache_get_async("shodan:example.com") == {"ports": [80]}
    assert await cache_mod.cache_get_async("missing:example.com") is None


def test_pg_dsn_strips_driver_suffix():
    assert (
        cache_mod._pg_dsn("postgresql+asyncpg://u:p@localhost:5432/osint")
        == "postgresql://u:p@localhost:5432/osint"
    )


@pytest.mark.asyncio
async def test_postgres_unreachable_never_raises(monkeypatch):
    """Dead Postgres → get returns None, set swallows; scans must never 500."""
    monkeypatch.setattr(settings, "cache_backend", "postgres")
    # Localhost closed port: connection refused fast, never hangs the suite.
    monkeypatch.setattr(settings, "database_url", "postgresql://u:p@127.0.0.1:1/osint")
    assert await cache_mod.cache_get_async("shodan:example.com") is None
    await cache_mod.cache_set_async(
        "shodan:example.com", {"ports": []}
    )  # must not raise
