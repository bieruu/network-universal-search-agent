import pytest
from fastapi import HTTPException

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
        await require_user(authorization=None, cookie=None)
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
            await require_user(authorization=junk, cookie=None)
        assert e.value.status_code == 401


@pytest.mark.asyncio
async def test_cookie_session_accepted_without_token_material():
    uid = await require_user(
        authorization=None, cookie="better-auth.session_token=abc; other=1"
    )
    assert uid == "user:session"


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
