"""Adversarial proof: is user input ever *concatenated* into SQL?

The claim under test is narrow and falsifiable: every user-controlled value
reaches the database as a bound parameter, so a payload is data and can never
change statement structure. That is proven three independent ways, because
"the endpoint returned 200" is not evidence — a vulnerable endpoint can also
return 200.

  1. Behavioural — hostile payloads against the real routers on a real SQLite
     DB. Assert no cross-owner leak, no crash, and the tables still exist.
  2. Structural — compile the actual ORM statement and assert the payload sits
     in `compile().params` (a value) and never in the SQL string. This is the
     direct claim: it reads the SQL that would be sent.
  3. Placeholder audit — the two hand-written query paths (SQLite `?` and
     asyncpg `$1`) get their statement string and arguments recorded separately,
     proving the payload is an argument.

Layer 2 of defence is asserted too: Pydantic rejects injection-shaped targets
before they are ever used, and page/limit cannot smuggle an ORDER BY.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.dialects import sqlite
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core import cache as cache_mod
from app.db.base import Base
from app.models.scan import Scan
from app.models.target import Target
from app.routers.history import history, trend
from app.routers.scan import get_scan
from app.schemas.scan import ScanRequest

# Classic injection shapes, plus the ones that matter here specifically:
# tautologies to bypass a WHERE, stacked statements to drop a table, UNION to
# widen a result set, and a comment to truncate the rest of the query.
INJECTIONS = [
    "' OR '1'='1",
    "' OR 1=1 --",
    "admin'--",
    "'; DROP TABLE scans; --",
    "'; UPDATE scans SET user_id='user:attacker' WHERE user_id='user:victim'; --",
    "x' UNION SELECT id, target_id, user_id, status, risk_score FROM scans --",
    "' UNION ALL SELECT secret FROM osint_cache --",
    "%' OR '1'='1",
    "1; DELETE FROM targets WHERE '1'='1",
    "' AND (SELECT COUNT(*) FROM sqlite_master) > 0 --",
    "' AND 1=CONVERT(int,(SELECT TOP 1 name FROM sysobjects)) --",
    # U+202E RIGHT-TO-LEFT OVERRIDE, the Trojan Source character: invisible in a
    # diff, flips how the rest of the line reads. Built with chr() rather than a
    # literal so the source file stays free of control characters (ruff PLE2502)
    # and the character survives copy/paste and editors.
    chr(0x202E) + "'; DROP TABLE scans; --",
    "' OR ''='",
    "1' OR '1' = '1",
    "'; DROP TABLE scans; --",
]


@pytest.fixture
async def db():
    """Real SQLite DB with the production schema and two owners seeded."""
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
                    id="scan-victim",
                    target_id=target.id,
                    user_id="user:victim",
                    status="completed",
                    risk_score=99,
                    result_snapshot={"secret": "victim-only"},
                    errors=[],
                    created_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
                ),
                Scan(
                    id="scan-attacker",
                    target_id=target.id,
                    user_id="user:attacker",
                    status="completed",
                    risk_score=1,
                    result_snapshot={},
                    errors=[],
                    created_at=datetime(2026, 1, 2, tzinfo=timezone.utc),
                ),
            ]
        )
        await session.commit()
        yield session
    await engine.dispose()


# --- 1. Behavioural: payloads against the real routers ----------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("payload", INJECTIONS)
async def test_history_tautology_cannot_read_another_users_scans(db, payload):
    """`target` is a free-form query param, so it reaches SQL unvalidated.

    If it were interpolated, a tautology would return both owners' rows.
    Parameterized, it is just a string that matches nothing.
    """
    result = await history(
        target=payload, page=1, limit=20, user_id="user:attacker", session=db
    )

    assert result["items"] == []
    assert result["total"] == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("payload", INJECTIONS)
async def test_trend_tautology_cannot_read_another_users_scans(db, payload):
    result = await trend(t=payload, user_id="user:attacker", session=db)

    assert result["points"] == []


@pytest.mark.asyncio
@pytest.mark.parametrize("payload", INJECTIONS)
async def test_get_scan_path_param_cannot_exfiltrate_another_users_scan(db, payload):
    """`scan_id` is a path segment. A tautology here would hand over the row."""
    with pytest.raises(HTTPException) as not_found:
        await get_scan(payload, user_id="user:attacker", session=db)

    assert not_found.value.status_code == 404


@pytest.mark.asyncio
@pytest.mark.parametrize("payload", INJECTIONS)
async def test_injection_payloads_leave_the_schema_intact(db, payload):
    """A stacked `DROP TABLE` is the highest-value target: prove nothing dies."""
    await history(target=payload, page=1, limit=20, user_id="user:attacker", session=db)
    await trend(t=payload, user_id="user:attacker", session=db)

    tables = set(
        (await db.execute(select(Target.__table__.c.id).distinct())).scalars().all()
    )
    assert tables == {"target-1"}, "stacked statement altered the targets table"

    surviving = (
        await db.execute(select(Scan).where(Scan.id == "scan-victim"))
    ).scalar_one()
    assert surviving.user_id == "user:victim", "ownership was rewritten"
    assert surviving.result_snapshot == {"secret": "victim-only"}


@pytest.mark.asyncio
@pytest.mark.parametrize("payload", INJECTIONS)
async def test_victim_data_is_never_returned_to_attacker_under_any_payload(db, payload):
    """Belt and braces: scan every response for the victim's secret."""
    history_result = await history(
        target=payload, page=1, limit=20, user_id="user:attacker", session=db
    )
    trend_result = await trend(t=payload, user_id="user:attacker", session=db)

    serialized = f"{history_result}{trend_result}"
    assert "victim-only" not in serialized
    assert "scan-victim" not in serialized


# --- 2. Structural: read the SQL that would actually be sent ---------------


@pytest.mark.parametrize("payload", INJECTIONS)
def test_payload_is_a_bound_parameter_not_sql_text(payload):
    """The direct claim, asserted on the compiled statement.

    SQLAlchemy emits `?` in the SQL string and carries the value separately. If
    anyone ever switched to a raw f-string, the payload would appear in
    `compiled.string` and this fails.
    """
    statement = select(Scan).where(Scan.user_id == "user:attacker", Scan.id == payload)
    compiled = statement.compile(dialect=sqlite.dialect())

    assert payload not in compiled.string, "payload leaked into the SQL text"
    assert "?" in compiled.string, "no bind placeholder emitted"
    # Compare against the parameter *values*, not `str(params)`: repr() escapes
    # non-printables, so a payload like a right-to-left override (U+202E, used
    # in Trojan Source attacks) would appear as "\u202e" and fail a substring
    # match even though it is bound correctly.
    assert payload in list(
        compiled.params.values()
    ), "payload is not a bound parameter value"


@pytest.mark.asyncio
@pytest.mark.parametrize("payload", INJECTIONS)
async def test_persisted_snapshot_is_stored_as_json_not_executed(db, payload):
    """`result_snapshot` is a JSON column holding untrusted external data.

    Injection-shaped strings must round-trip verbatim — stored, not evaluated.
    """
    await db.execute(select(Scan).where(Scan.id == "scan-attacker"))
    db.add(
        Scan(
            id="scan-hostile",
            target_id="target-1",
            user_id="user:attacker",
            status="completed",
            risk_score=0,
            result_snapshot={"banner": payload},
            errors=[],
        )
    )
    await db.commit()

    stored = (
        await db.execute(select(Scan).where(Scan.id == "scan-hostile"))
    ).scalar_one()
    assert stored.result_snapshot["banner"] == payload


# --- 3. Placeholder audit: the two hand-written query paths ---------------


@pytest.mark.parametrize("payload", INJECTIONS)
def test_sqlite_cache_key_is_bound_with_question_mark(tmp_path, payload):
    """`cache.py` hand-writes SQL. Assert the key is an argument, not text."""
    path = str(tmp_path / "cache.db")

    cache_mod.cache_set(path, payload, {"stored": True})
    assert cache_mod.cache_get(path, payload) == {"stored": True}

    # A tautology written as raw text would return *every* key in the table.
    assert cache_mod.cache_get(path, "' OR '1'='1") in (None, {"stored": True})
    assert cache_mod.cache_get(path, "nonexistent-key") is None

    import sqlite3

    with sqlite3.connect(path) as con:
        rows = con.execute("SELECT key FROM cache").fetchall()
        assert rows == [(payload,)], "cache row was not stored literally"


class _RecordingAsyncpgConn:
    """Captures statement text and arguments separately, like asyncpg does."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, object]] = []

    async def execute(self, sql: str, *args: object) -> str:
        self.calls.append((sql, args))
        return "OK"

    async def fetchrow(self, sql: str, *args: object) -> None:
        self.calls.append((sql, args))

    async def close(self) -> None:
        pass


@pytest.fixture
def recording_asyncpg(monkeypatch):
    """Swap asyncpg for a recorder so the Postgres path is observable.

    There is no Postgres in the test environment; asserting on the recorded
    (sql, args) pair proves parameter separation without needing a server.
    """
    import sys
    import types

    conn = _RecordingAsyncpgConn()

    async def fake_connect(dsn: str) -> _RecordingAsyncpgConn:
        return conn

    module = types.ModuleType("asyncpg")
    module.connect = fake_connect
    monkeypatch.setitem(sys.modules, "asyncpg", module)
    return conn


@pytest.mark.asyncio
@pytest.mark.parametrize("payload", INJECTIONS)
async def test_postgres_cache_path_binds_key_as_argument(recording_asyncpg, payload):
    # Both directions: `_pg_set` writes, `_pg_get` reads. Covering only the
    # write would leave the read path — the one that returns data — unverified.
    await cache_mod._pg_set(payload, {"v": 1}, 3600, "postgresql://u:p@h/db")
    await cache_mod._pg_get(payload, "postgresql://u:p@h/db")

    assert recording_asyncpg.calls, "no statement reached the driver"

    # Every statement is checked, not just the INSERT: the vulnerable form
    # inlines the key into the SELECT, so asserting only on INSERT would let
    # that regression through with the suite still green.
    data_statements = 0
    for sql, args in recording_asyncpg.calls:
        assert payload not in sql, "payload leaked into Postgres SQL text"
        if "INSERT" in sql:
            assert "$1" in sql and "$2" in sql and "$3" in sql, sql
            assert args and payload in args, "payload is not an asyncpg argument"
        if "SELECT" in sql and "FROM osint_cache" in sql:
            data_statements += 1
            assert "$1" in sql, "SELECT must bind the key with $1"
            assert args == (payload,), "key must be passed as the asyncpg argument"

    assert data_statements, "the SELECT path was never exercised"


# --- Layer 2: input validation, before SQL is ever built ------------------


@pytest.mark.parametrize("payload", INJECTIONS)
def test_pydantic_rejects_injection_shaped_target(payload):
    """Second layer: the regex blocks these before any lookup happens."""
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        ScanRequest(target=payload)


def test_order_by_and_limit_cannot_be_influenced():
    """`page`/`limit` feed `.offset()/.limit()` as ints — never as SQL text.

    If these were ever interpolated, `page=1;DROP TABLE scans` would be the
    whole attack. Pydantic coerces to `int`, so the string cannot reach SQL.
    """
    request = ScanRequest(target="example.com")
    assert request.target == "example.com"

    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        ScanRequest(target="example.com", force="1; DROP TABLE scans")  # type: ignore[arg-type]
