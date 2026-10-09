"""SQLite TTL cache for raw OSINT JSON. Postgres remains source of truth.

Async helpers (`cache_get_async` / `cache_set_async`) branch on
`settings.cache_backend`: sqlite runs the sync logic in `asyncio.to_thread`
(never block the event loop); postgres uses asyncpg against the
`osint_cache` table. Cache failures never raise — a dead cache must
never 500 a scan.
"""

from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import time
from typing import Any
from urllib.parse import parse_qsl, unquote, urlsplit

_PG_DDL = (
    "CREATE TABLE IF NOT EXISTS osint_cache"
    "(key TEXT PRIMARY KEY, payload TEXT, expires_at BIGINT)"
)
_PG_TIMEOUT = 2.0  # short: cache must never stall a scan


def _db_path(path: str) -> str:
    d = os.path.dirname(os.path.abspath(path))
    if d:
        os.makedirs(d, exist_ok=True)
    return path


def _connect(path: str) -> sqlite3.Connection:
    con = sqlite3.connect(_db_path(path))
    con.execute(
        "CREATE TABLE IF NOT EXISTS cache(key TEXT PRIMARY KEY, payload TEXT, expires_at INTEGER)"
    )
    return con


def cache_get(path: str, key: str) -> Any | None:
    try:
        con = _connect(path)
        try:
            row = con.execute(
                "SELECT payload, expires_at FROM cache WHERE key=?", (key,)
            ).fetchone()
        finally:
            con.close()
        if not row:
            return None
        payload, expires_at = row
        if int(time.time()) > int(expires_at):
            cache_delete(path, key)
            return None
        return json.loads(payload)
    except Exception:  # noqa: BLE001 — cache must never fail a scan
        return None


def cache_set(path: str, key: str, value: Any, ttl_seconds: int = 86400) -> None:
    try:
        con = _connect(path)
        try:
            con.execute(
                "INSERT OR REPLACE INTO cache(key, payload, expires_at) VALUES(?,?,?)",
                (key, json.dumps(value, default=str), int(time.time()) + ttl_seconds),
            )
            con.commit()
        finally:
            con.close()
    except Exception:  # noqa: BLE001, S110 — cache must never fail a scan
        pass


def cache_delete(path: str, key: str) -> None:
    try:
        con = _connect(path)
        try:
            con.execute("DELETE FROM cache WHERE key=?", (key,))
            con.commit()
        finally:
            con.close()
    except Exception:  # noqa: BLE001, S110 — cache must never fail a scan
        pass


def _pg_connect_kwargs(database_url: str) -> dict[str, Any]:
    """Split a SQLAlchemy Postgres URL into keyword arguments for asyncpg.

    Passing the URL straight to `asyncpg.connect(dsn=...)` does NOT work once
    it carries a TLS parameter: asyncpg parses *query parameters* in a DSN as
    **server settings** to apply at startup, not as connection options, so
    `?ssl=require` is handed to Postgres as a runtime parameter and rejected
    with `CantChangeRuntimeParamError: parameter "ssl" cannot be changed now`
    (reproduced against asyncpg 0.31 and a managed Postgres). The TLS
    parameter therefore has to leave the query string and arrive as an
    explicit `ssl=` keyword, which is the only spelling asyncpg accepts
    there — the same split WORKFLOW.md 8.1 records for the engine.

    Failure is silent in the worst possible way: this module swallows every
    exception by design (a dead cache must never fail a scan), so a cache
    that cannot connect leaves no trace except that nothing is ever cached
    and every scan pays for Shodan again. Percent-encoding is undone here
    because `urlsplit` hands back the raw components, and asyncpg expects the
    real password rather than its encoded form.
    """
    parts = urlsplit(
        database_url.replace("+asyncpg", "")
        .replace("+psycopg", "")
        .replace("postgresqls://", "postgresql://")
    )
    opts: dict[str, Any] = {
        "host": parts.hostname or "localhost",
        "port": parts.port or 5432,
        "database": parts.path.lstrip("/"),
    }
    if parts.username:
        opts["user"] = unquote(parts.username)
    if parts.password:
        opts["password"] = unquote(parts.password)
    for key, value in parse_qsl(parts.query):
        # asyncpg's connect() takes `ssl`, not `sslmode`; both spellings can
        # legitimately arrive here depending on which side of the deployment
        # wrote the URL, and both mean the same thing.
        if key in ("ssl", "sslmode"):
            opts["ssl"] = value
    return opts


async def _pg_get(key: str, database_url: str) -> Any | None:
    import asyncpg

    con = await asyncio.wait_for(
        asyncpg.connect(**_pg_connect_kwargs(database_url)), timeout=_PG_TIMEOUT
    )
    try:
        await con.execute(_PG_DDL)
        row = await asyncio.wait_for(
            con.fetchrow(
                "SELECT payload, expires_at FROM osint_cache WHERE key=$1", key
            ),
            timeout=_PG_TIMEOUT,
        )
        if not row:
            return None
        if int(time.time()) > int(row["expires_at"]):
            await con.execute("DELETE FROM osint_cache WHERE key=$1", key)
            return None
        return json.loads(row["payload"])
    finally:
        await con.close()


async def _pg_set(key: str, value: Any, ttl_seconds: int, database_url: str) -> None:
    import asyncpg

    con = await asyncio.wait_for(
        asyncpg.connect(**_pg_connect_kwargs(database_url)), timeout=_PG_TIMEOUT
    )
    try:
        await con.execute(_PG_DDL)
        await asyncio.wait_for(
            con.execute(
                "INSERT INTO osint_cache(key, payload, expires_at) VALUES($1,$2,$3) "
                "ON CONFLICT(key) DO UPDATE SET payload=EXCLUDED.payload, "
                "expires_at=EXCLUDED.expires_at",
                key,
                json.dumps(value, default=str),
                int(time.time()) + ttl_seconds,
            ),
            timeout=_PG_TIMEOUT,
        )
    finally:
        await con.close()


async def cache_get_async(key: str) -> Any | None:
    """Branch on settings.cache_backend; never raises (returns None on failure)."""
    from app.core.config import settings

    try:
        if settings.cache_backend == "postgres":
            return await _pg_get(key, settings.database_url)
        return await asyncio.to_thread(cache_get, settings.sqlite_path, key)
    except Exception:  # noqa: BLE001 — cache must never fail a scan
        return None


async def cache_set_async(key: str, value: Any, ttl_seconds: int = 86400) -> None:
    """Branch on settings.cache_backend; swallows all errors."""
    from app.core.config import settings

    try:
        if settings.cache_backend == "postgres":
            await _pg_set(key, value, ttl_seconds, settings.database_url)
        else:
            await asyncio.to_thread(
                cache_set, settings.sqlite_path, key, value, ttl_seconds
            )
    except Exception:  # noqa: BLE001, S110 — cache must never fail a scan
        pass
