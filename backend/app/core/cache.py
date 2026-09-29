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


def _pg_dsn(database_url: str) -> str:
    """Strip the SQLAlchemy driver suffix so asyncpg gets a plain DSN."""
    return database_url.replace("+asyncpg", "").replace("+psycopg", "")


async def _pg_get(key: str, database_url: str) -> Any | None:
    import asyncpg

    con = await asyncio.wait_for(
        asyncpg.connect(_pg_dsn(database_url)), timeout=_PG_TIMEOUT
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
        asyncpg.connect(_pg_dsn(database_url)), timeout=_PG_TIMEOUT
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
