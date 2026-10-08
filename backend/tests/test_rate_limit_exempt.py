"""The rate-limit exemption is a testing switch, not a backdoor.

It exists because QA/load testing kept hitting our own 429 before it ever
reached the provider limits that actually matter for that work.

What these tests pin, in order of importance:

  1. The exemption is opt-in. Empty setting = nobody is exempt, including the
     service identity. A deployment that never configures it behaves exactly as
     before.
  2. A session-cookie subject is NOT exempt by accident. `require_user()`
     returns `user:<db-id>` for a cookie and `user:service` only for a bearer
     token matching SERVICE_TOKEN, so exempting the service identity cannot be
     reached from a browser. These tests assert that a cookie subject stays
     limited even while the service identity is exempt.
  3. Matching is exact, never a prefix, so `user:service` cannot exempt
     `user:service-admin` or an id that merely starts the same way.
  4. An exempt request is not merely uncapped — it is not *charged*. It creates
     no bucket and does not bill the instance daily budget, because the point
     is that testing must not silently consume the real cost backstop.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from app.core import rate_limit
from app.core.config import settings

SERVICE = "user:service"
DB_USER = "user:abc123"


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    rate_limit.reset_for_tests()
    # Default to "nobody exempt" so each test opts in explicitly. Reading it
    # through getattr mirrors the module's own defensive read, and keeps this
    # file independent of whether the field is declared yet.
    monkeypatch.setattr(settings, "rate_limit_exempt_subjects", "", raising=False)
    rate_limit.reset_for_tests()
    yield
    rate_limit.reset_for_tests()


def _exempt(monkeypatch, *subjects: str) -> None:
    """Name the subjects that bypass the limiter, as an operator would."""
    monkeypatch.setattr(
        settings, "rate_limit_exempt_subjects", ",".join(subjects), raising=False
    )


# --- 1. opt-in ---------------------------------------------------------------


def test_nobody_is_exempt_by_default(monkeypatch):
    monkeypatch.setattr(settings, "rate_limit_per_hour", 2)
    rate_limit.check_rate_limit(SERVICE)
    rate_limit.check_rate_limit(SERVICE)
    with pytest.raises(HTTPException) as err:
        rate_limit.check_rate_limit(SERVICE)
    assert err.value.status_code == 429


def test_service_token_may_scan_without_limit(monkeypatch):
    _exempt(monkeypatch, SERVICE)
    monkeypatch.setattr(settings, "rate_limit_per_hour", 1)
    # Deliberately far past the hourly cap of 1.
    for _ in range(25):
        rate_limit.check_rate_limit(SERVICE)


def test_the_service_identity_is_not_exempt_until_it_is_named(monkeypatch):
    """A bearer token alone grants nothing; the operator must name it."""
    monkeypatch.setattr(settings, "rate_limit_per_hour", 1)
    rate_limit.check_rate_limit(SERVICE)
    with pytest.raises(HTTPException):
        rate_limit.check_rate_limit(SERVICE)


# --- 2. a browser subject is never exempt by accident ------------------------


def test_a_cookie_subject_stays_limited_while_service_is_exempt(monkeypatch):
    """The security property that makes this design acceptable.

    `user:service` is exempt for testing; a real signed-in user must still be
    capped, because their subject comes from a cookie that can be stolen.
    """
    _exempt(monkeypatch, SERVICE)
    monkeypatch.setattr(settings, "rate_limit_per_hour", 2)

    rate_limit.check_rate_limit(DB_USER)
    rate_limit.check_rate_limit(DB_USER)
    with pytest.raises(HTTPException) as err:
        rate_limit.check_rate_limit(DB_USER)
    assert err.value.status_code == 429


def test_free_bucket_is_exempt_only_for_the_named_subject(monkeypatch):
    _exempt(monkeypatch, SERVICE)
    monkeypatch.setattr(settings, "free_rate_limit_per_hour", 1)

    for _ in range(10):
        rate_limit.check_free_rate_limit(SERVICE, "contacts")

    rate_limit.check_free_rate_limit(DB_USER, "contacts")
    with pytest.raises(HTTPException):
        rate_limit.check_free_rate_limit(DB_USER, "contacts")


def test_exempt_scopes_do_not_leak_between_themselves(monkeypatch):
    """Each free scope keeps its own keyspace, exemption included."""
    _exempt(monkeypatch, SERVICE)
    monkeypatch.setattr(settings, "free_rate_limit_per_hour", 1)
    for _ in range(5):
        rate_limit.check_free_rate_limit(SERVICE, "phone")
        rate_limit.check_free_rate_limit(SERVICE, "exif")
    assert rate_limit._buckets == {}, "an exempt call must not create a bucket"


# --- 3. exact matching -------------------------------------------------------


@pytest.mark.parametrize(
    "subject",
    [
        "user:service-admin",
        "user:servic",
        "user:service2",
        "user:Service",
        " service",
        "service",
        "user:",
    ],
)
def test_no_prefix_or_fuzzy_match_grants_exemption(monkeypatch, subject):
    _exempt(monkeypatch, SERVICE)
    assert rate_limit._is_exempt(subject) is False


@pytest.mark.parametrize("raw", ["", "   ", ",", ", ,", None])
def test_malformed_setting_exempts_nobody(monkeypatch, raw):
    monkeypatch.setattr(settings, "rate_limit_exempt_subjects", raw, raising=False)
    assert rate_limit._is_exempt(SERVICE) is False
    assert rate_limit._is_exempt(DB_USER) is False


def test_whitespace_around_a_configured_subject_is_tolerated(monkeypatch):
    monkeypatch.setattr(
        settings,
        "rate_limit_exempt_subjects",
        " user:qa , user:service ",
        raising=False,
    )
    assert rate_limit._is_exempt(SERVICE) is True
    assert rate_limit._is_exempt("user:qa") is True
    assert rate_limit._is_exempt(DB_USER) is False


def test_several_subjects_can_be_listed(monkeypatch):
    _exempt(monkeypatch, "user:qa", "user:loadtest", SERVICE)
    for subject in ("user:qa", "user:loadtest", SERVICE):
        assert rate_limit._is_exempt(subject) is True
    assert rate_limit._is_exempt("user:someone-else") is False


def test_empty_subject_is_never_exempt(monkeypatch):
    _exempt(monkeypatch, SERVICE, "")
    assert rate_limit._is_exempt("") is False
    assert rate_limit._is_exempt("   ") is False


# --- 4. an exempt call is not charged ---------------------------------------


def test_an_exempt_scan_does_not_bill_the_instance_daily_budget(monkeypatch):
    """Testing must not quietly eat the cost backstop.

    `rate_limit_daily_total` exists to bound spend on the paid Shodan key. If an
    exempt call were billed, a load test would drain the real budget and the
    *next* real user would get a 429 for the test's spending.
    """
    _exempt(monkeypatch, SERVICE)
    # Only the daily budget is the limiter here. The hourly quota is set high on
    # purpose: with it at 1 it would fire first and the test would prove
    # nothing about the instance budget.
    monkeypatch.setattr(settings, "rate_limit_daily_total", 2)
    monkeypatch.setattr(settings, "rate_limit_per_hour", 100)

    for _ in range(10):
        rate_limit.check_rate_limit(SERVICE)

    # The budget is untouched, so a real user can still spend all of it: two
    # admitted, and the third refused by the instance cap rather than by the
    # exempt calls that preceded it.
    rate_limit.check_rate_limit(DB_USER)
    rate_limit.check_rate_limit(DB_USER)
    with pytest.raises(HTTPException) as err:
        rate_limit.check_rate_limit(DB_USER)
    assert err.value.status_code == 429


def test_an_exempt_call_creates_no_bucket(monkeypatch):
    _exempt(monkeypatch, SERVICE)
    rate_limit.check_rate_limit(SERVICE)
    rate_limit.check_free_rate_limit(SERVICE, "dns")
    assert SERVICE not in rate_limit._buckets
    assert f"free:dns:{SERVICE}" not in rate_limit._buckets
    assert rate_limit._buckets == {}


def test_usage_is_logged_so_a_forgotten_exemption_is_visible(monkeypatch, caplog):
    _exempt(monkeypatch, SERVICE)
    with caplog.at_level("WARNING", logger="app.core.rate_limit"):
        rate_limit.check_rate_limit(SERVICE)
    assert any("rate_limit_exempt" in r.getMessage() for r in caplog.records)
    # The subject is named so an operator can see who is bypassing what.
    assert any(SERVICE in r.getMessage() for r in caplog.records)


def test_the_toggle_takes_effect_without_a_restart(monkeypatch):
    """Read per call on purpose, so flipping the setting is instant."""
    monkeypatch.setattr(settings, "rate_limit_per_hour", 1)
    rate_limit.check_rate_limit(SERVICE)
    with pytest.raises(HTTPException):
        rate_limit.check_rate_limit(SERVICE)

    _exempt(monkeypatch, SERVICE)  # operator turns it on mid-process
    for _ in range(5):
        rate_limit.check_rate_limit(SERVICE)

    monkeypatch.setattr(settings, "rate_limit_exempt_subjects", "", raising=False)
    with pytest.raises(HTTPException):
        rate_limit.check_rate_limit(SERVICE)


# --- the dependency that makes the subject safe ------------------------------


@pytest.mark.asyncio
async def test_a_cookie_session_can_never_produce_the_exempt_subject(monkeypatch):
    """End-to-end: `require_user` must not yield `user:service` from a cookie.

    This is the link the whole design rests on. If a cookie could ever produce
    the exempt subject, exempting the service identity would exempt every
    signed-in user.
    """
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.security import require_user

    secret = "s3cr3t-shared-value-32chars!!-extra"
    monkeypatch.setattr(settings, "better_auth_secret", secret)
    monkeypatch.setattr(
        settings, "database_url", "postgresql+asyncpg://localhost/osint"
    )

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.execute(
            text(
                'CREATE TABLE "session" (token TEXT PRIMARY KEY, '
                '"userId" TEXT, "expiresAt" TEXT)'
            )
        )
        await connection.execute(
            text(
                'INSERT INTO "session" (token, "userId", "expiresAt") '
                "VALUES ('opaque-valid-token', 'user_123', '2099-01-01 00:00:00')"
            )
        )
    factory = async_sessionmaker(engine, expire_on_commit=False)
    import base64
    import hmac
    from urllib.parse import quote

    async with factory() as session:
        token = "opaque-valid-token"
        signature = base64.b64encode(
            hmac.new(secret.encode(), token.encode(), "sha256").digest()
        ).decode("ascii")
        subject = await require_user(
            authorization=None,
            cookie=f"better-auth.session_token={quote(f'{token}.{signature}', safe='.')}",
            session=session,
        )

    await engine.dispose()

    assert subject == "user:user_123"
    assert subject != SERVICE
    # And that subject is not exempt just because the service one is.
    _exempt(monkeypatch, SERVICE)
    assert rate_limit._is_exempt(subject) is False
