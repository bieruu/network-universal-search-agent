import base64
import hmac
from urllib.parse import quote

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core import rate_limit
from app.core.security import assert_target_allowed, require_user


def test_private_ip_blocked():
    for t in (
        "localhost",
        "127.0.0.1",
        "10.0.0.5",
        "192.168.1.1",
        "172.16.0.1",
        "169.254.1.1",
    ):
        with pytest.raises(HTTPException):
            assert_target_allowed(t)
    assert_target_allowed("example.com")
    assert_target_allowed("8.8.8.8")


@pytest.mark.asyncio
async def test_unaauthed_401():
    with pytest.raises(HTTPException) as e:
        await require_user(session=None, authorization=None, cookie=None)
    assert e.value.status_code == 401


@pytest.mark.asyncio
async def test_random_bearer_rejected_fail_closed():
    # Regression: old stub accepted any Bearer token >= 16 chars.
    for junk in (
        "Bearer hunter2",
        "Bearer " + "x" * 64,
        "Bearer a-very-long-forged-token",
    ):
        with pytest.raises(HTTPException) as e:
            await require_user(session=None, authorization=junk, cookie=None)
        assert e.value.status_code == 401


@pytest.mark.asyncio
async def test_fake_cookie_rejected_fail_closed(monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(
        settings, "better_auth_secret", "s3cr3t-shared-value-32chars!!-extra"
    )
    monkeypatch.setattr(
        settings, "database_url", "postgresql+asyncpg://localhost/osint"
    )
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.execute(
            text(
                'CREATE TABLE "session" (token TEXT PRIMARY KEY, "userId" TEXT, "expiresAt" TEXT)'
            )
        )
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as session:
        with pytest.raises(HTTPException) as e:
            await require_user(
                authorization=None,
                cookie="better-auth.session_token=not-a-real-session; other=1",
                session=session,
            )
    assert e.value.status_code == 401
    await engine.dispose()


@pytest.mark.asyncio
async def test_better_auth_cookie_requires_active_database_session(monkeypatch):
    from app.core.config import settings

    secret = "s3cr3t-shared-value-32chars!!-extra"
    monkeypatch.setattr(settings, "better_auth_secret", secret)
    monkeypatch.setattr(
        settings, "database_url", "postgresql+asyncpg://localhost/osint"
    )
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.execute(
            text(
                'CREATE TABLE "session" (token TEXT PRIMARY KEY, "userId" TEXT, "expiresAt" TEXT)'
            )
        )
        await connection.execute(
            text("""INSERT INTO "session" (token, "userId", "expiresAt")
               VALUES ('opaque-valid-token', 'user_123', '2099-01-01 00:00:00'),
                      ('opaque-expired-token', 'user_456', '2000-01-01 00:00:00')""")
        )
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as session:
        token = "opaque-valid-token"
        signature = base64.b64encode(
            hmac.new(secret.encode(), token.encode(), "sha256").digest()
        ).decode("ascii")
        uid = await require_user(
            authorization=None,
            cookie=f"better-auth.session_token={quote(f'{token}.{signature}', safe='.')}",
            session=session,
        )
        assert uid == "user:user_123"
        with pytest.raises(HTTPException) as forged:
            await require_user(
                authorization=None,
                cookie=f"better-auth.session_token={token}.invalid-signature",
                session=session,
            )
        assert forged.value.status_code == 401
        with pytest.raises(HTTPException) as expired:
            await require_user(
                authorization=None,
                cookie="better-auth.session_token=opaque-expired-token",
                session=session,
            )
        assert expired.value.status_code == 401
    await engine.dispose()


@pytest.mark.asyncio
async def test_cookie_auth_fails_closed_without_postgres_session_store(monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(
        settings, "better_auth_secret", "s3cr3t-shared-value-32chars!!-extra"
    )
    monkeypatch.setattr(settings, "database_url", "sqlite+aiosqlite:///./data/cache.db")
    with pytest.raises(HTTPException) as error:
        await require_user(
            session=None,
            authorization=None,
            cookie="better-auth.session_token=opaque-token",
        )
    assert error.value.status_code == 503


@pytest.mark.asyncio
async def test_service_bearer_accepted_only_on_exact_secret(monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "better_auth_secret", "s3cr3t-shared-value-32chars!!")
    uid = await require_user(
        authorization="Bearer s3cr3t-shared-value-32chars!!", cookie=None
    )
    assert uid == "user:service"
    with pytest.raises(HTTPException) as e:
        await require_user(
            authorization="Bearer s3cr3t-shared-value-32chars!?", cookie=None
        )
    assert e.value.status_code == 401


def test_production_rejects_placeholder_auth_secret(monkeypatch):
    from app.core.config import Settings

    monkeypatch.setenv("APP_ENV", "production")
    with pytest.raises(ValidationError):
        Settings(better_auth_secret="replace-with-at-least-32-random-characters")


def test_cors_locked_down():
    from fastapi.middleware.cors import CORSMiddleware

    from app.main import create_app

    app = create_app()
    cors = [m for m in app.user_middleware if m.cls is CORSMiddleware]
    assert cors, "CORSMiddleware must be registered"
    opts = cors[0].kwargs
    assert "*" not in opts["allow_methods"]
    assert "*" not in opts["allow_headers"]
    assert set(opts["allow_methods"]) <= {"GET", "POST", "OPTIONS"}


def test_rate_limit_enforced(monkeypatch):
    monkeypatch.setattr(rate_limit.settings, "rate_limit_per_hour", 2)
    rate_limit.reset_for_tests()
    rate_limit.check_rate_limit("u")
    rate_limit.check_rate_limit("u")
    with pytest.raises(HTTPException) as e:
        rate_limit.check_rate_limit("u")
    assert e.value.status_code == 429
    rate_limit.reset_for_tests()
