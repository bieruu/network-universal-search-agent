"""CACHE_BACKEND flag tests: sqlite round-trip + postgres failure safety."""

from __future__ import annotations

import sys

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


def test_pg_connect_kwargs_strips_driver_suffix():
    opts = cache_mod._pg_connect_kwargs("postgresql+asyncpg://u:p@localhost:5432/osint")
    assert opts == {
        "host": "localhost",
        "port": 5432,
        "database": "osint",
        "user": "u",
        "password": "p",
    }
    # No TLS parameter means no ssl keyword: asyncpg would then refuse a
    # non-localhost server, which is the correct fail-closed direction.
    assert "ssl" not in opts


@pytest.mark.parametrize("param", ["ssl", "sslmode"])
def test_pg_connect_kwargs_moves_tls_out_of_the_query(param):
    """The regression: `?ssl=require` inside a DSN is a *server setting*.

    asyncpg applies unknown query parameters as startup settings, so leaving
    the TLS parameter in the DSN string makes Postgres reject it with
    `CantChangeRuntimeParamError: parameter "ssl" cannot be changed now` --
    raised on every cache read and write, and swallowed, so the cache is dead
    and every scan pays for Shodan again without a word in the logs.
    """
    opts = cache_mod._pg_connect_kwargs(
        f"postgresql+asyncpg://u:p@db.example.supabase.co:5432/postgres?{param}=require"
    )
    # asyncpg's connect() only accepts `ssl`, whatever the URL said.
    assert opts["ssl"] == "require"
    assert opts["host"] == "db.example.supabase.co"
    assert opts["port"] == 5432
    assert opts["database"] == "postgres"


def test_pg_connect_kwargs_decodes_percent_escapes():
    """A password with reserved characters arrives encoded in the URL.

    `urlsplit` does not decode, and asyncpg expects the real password, so an
    encoded one would fail authentication while looking perfectly correct.
    """
    opts = cache_mod._pg_connect_kwargs(
        "postgresql://postgres.ref:p%40ss%3Aword@db.example.supabase.co:5432/postgres"
        "?sslmode=no-verify"
    )
    assert opts["user"] == "postgres.ref"
    assert opts["password"] == "p@ss:word"
    assert opts["ssl"] == "no-verify"


def test_pg_connect_kwargs_defaults_and_edge_cases():
    # No port -> Postgres default, no password -> key omitted entirely rather
    # than sent as None.
    opts = cache_mod._pg_connect_kwargs("postgresql://u@db.example/osint?ssl=require")
    assert opts["port"] == 5432
    assert "password" not in opts
    assert opts["database"] == "osint"


@pytest.mark.asyncio
async def test_postgres_cache_passes_tls_as_a_keyword_not_in_the_dsn(monkeypatch):
    """End-to-end shape check: the call must not hand asyncpg a DSN string.

    Only the arguments are asserted -- no database is contacted -- because the
    bug this pins is an argument-shape bug.
    """
    captured: dict[str, object] = {}

    class FakeConnection:
        async def execute(self, *args, **kwargs):
            return None

        async def fetchrow(self, *args, **kwargs):
            return None

        async def close(self):
            return None

    class FakeAsyncpg:
        @staticmethod
        async def connect(*args, **kwargs):
            captured["positional"] = args
            captured["keyword"] = kwargs
            return FakeConnection()

        def __getattr__(self, name):  # pragma: no cover - not reached
            raise AttributeError(name)

    # cache.py imports settings lazily inside the helpers, so patch the object
    # on its home module rather than a name in app.core.cache.
    monkeypatch.setattr(settings, "cache_backend", "postgres")
    monkeypatch.setattr(
        settings, "database_url", "postgresql+asyncpg://u:p@h:5432/db?ssl=require"
    )
    monkeypatch.setitem(sys.modules, "asyncpg", FakeAsyncpg())

    await cache_mod.cache_set_async("k", {"a": 1}, 60)

    assert captured["positional"] == (), "the DSN must not be passed positionally"
    assert captured["keyword"]["ssl"] == "require"
    assert captured["keyword"]["host"] == "h"


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
