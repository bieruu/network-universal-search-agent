"""Guest (signed-out) scan path — the 2026-10-14 reversal.

DESIGN.md used to state "there is deliberately no anonymous scan path". The
operator reversed that on 2026-10-14 with a budget, so this file pins the four
things that make the reversal safe:

  1. admission — only a token signed with BETTER_AUTH_SECRET becomes a guest,
     and a failed credential never downgrades into one;
  2. quota — 2 per guest per 24h, an instance-wide guest budget no cookie can
     reset, and the shared Shodan budget charged too;
  3. scope — history/trend/analysis keep `require_user()`, so a guest can scan
     but cannot enumerate anyone's saved scans;
  4. ownership — a guest reads only rows written under its own `guest:<id>`.

The minter lives in `frontend/app/api/scan/[[...path]]/route.ts`; `mint()` below
is a reimplementation on purpose (a test that imports the production helper
cannot fail when the two sides drift apart — this one can).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import time
import types
from collections.abc import Iterator
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core import rate_limit
from app.core.config import settings
from app.core.security import require_user_or_guest
from app.db.base import Base
from app.models.scan import Scan
from app.models.target import Target
from app.routers.scan import get_scan

GUEST_ID = "0123456789abcdef0123456789abcdef"
OTHER_GUEST_ID = "fedcba9876543210fedcba9876543210"
VALID_SECRET = "x" * 64


def mint(secret: str, guest_id: str) -> str:
    """What the frontend proxy writes into the `nusa_guest` cookie."""
    signature = (
        base64.urlsafe_b64encode(
            hmac.new(
                secret.encode(), f"nusa-guest:{guest_id}".encode(), hashlib.sha256
            ).digest()
        )
        .decode("ascii")
        .rstrip("=")
    )
    return f"{guest_id}.{signature}"


@pytest.fixture
def guest_secret(monkeypatch: pytest.MonkeyPatch) -> str:
    # The default settings value is a *placeholder*, which both require_user and
    # require_user_or_guest refuse (nothing can be trusted to be signed). A guest
    # test therefore has to install a real one, exactly like a deployment does.
    monkeypatch.setattr(settings, "better_auth_secret", VALID_SECRET)
    return VALID_SECRET


@pytest.fixture
def guest_quota() -> Iterator[None]:
    rate_limit.reset_for_tests()
    yield
    rate_limit.reset_for_tests()


# --- 1. admission ---------------------------------------------------------


@pytest.mark.asyncio
async def test_a_signed_token_admits_a_guest(guest_secret: str) -> None:
    subject = await require_user_or_guest(
        guest_token=mint(guest_secret, GUEST_ID),
        authorization=None,
        cookie=None,
        session=None,  # type: ignore[arg-type] — no session is consulted without a cookie
    )
    assert subject == f"guest:{GUEST_ID}"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "token_factory",
    [
        pytest.param(lambda s: None, id="absent"),
        pytest.param(lambda s: "", id="empty"),
        pytest.param(lambda s: "not-a-token", id="no-dot"),
        pytest.param(lambda s: f"{GUEST_ID}.forged", id="forged-signature"),
        pytest.param(
            lambda s: f"{GUEST_ID}.{mint(s, GUEST_ID)[:-2]}00", id="flipped-signature"
        ),
        # The id is data, not a namespace: a value that could become a bucket key
        # or a log field is refused BEFORE the signature is even computed.
        pytest.param(lambda s: f"../../etc/passwd.{s}", id="path-shaped-id"),
        pytest.param(lambda s: f"{GUEST_ID.upper()}.{s}", id="wrong-charset"),
        pytest.param(lambda s: f"{GUEST_ID[:31]}.{s}", id="wrong-length"),
        pytest.param(
            lambda s: f"{GUEST_ID}.{mint(s, OTHER_GUEST_ID).split('.', 1)[1]}",
            id="signature-from-another-id",
        ),
    ],
)
async def test_anything_but_a_valid_signature_is_401(
    guest_secret: str, token_factory
) -> None:
    with pytest.raises(HTTPException) as raised:
        await require_user_or_guest(
            guest_token=token_factory(guest_secret),
            authorization=None,
            cookie=None,
            session=None,  # type: ignore[arg-type]
        )
    assert raised.value.status_code == 401


@pytest.mark.asyncio
async def test_a_bad_bearer_never_downgrades_to_a_guest(guest_secret: str) -> None:
    # A failed credential must not be answered with a weaker one — the guest
    # path only exists for callers that presented no credential at all.
    with pytest.raises(HTTPException) as raised:
        await require_user_or_guest(
            guest_token=mint(guest_secret, GUEST_ID),
            authorization="Bearer not-the-service-token",
            cookie=None,
            session=None,  # type: ignore[arg-type]
        )
    assert raised.value.status_code == 401


@pytest.mark.asyncio
async def test_a_service_token_beats_the_guest_token(
    guest_secret: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "service_token", "service-token-value")
    subject = await require_user_or_guest(
        guest_token=mint(guest_secret, GUEST_ID),
        authorization="Bearer service-token-value",
        cookie=None,
        session=None,  # type: ignore[arg-type]
    )
    assert subject == "user:service"


@pytest.mark.asyncio
async def test_guest_admission_closes_when_the_quota_is_zero(
    guest_secret: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    # 0 disables the feature, and it must read as "no credential" (401), not as
    # a spent quota (429) — the latter promises a reset that will never come.
    monkeypatch.setattr(settings, "guest_scan_limit_per_day", 0)
    with pytest.raises(HTTPException) as raised:
        await require_user_or_guest(
            guest_token=mint(guest_secret, GUEST_ID),
            authorization=None,
            cookie=None,
            session=None,  # type: ignore[arg-type]
        )
    assert raised.value.status_code == 401


@pytest.mark.asyncio
async def test_an_unconfigured_secret_refuses_guests(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The placeholder is forced rather than assumed: a developer's backend/.env
    # may carry a real secret (and CI carries none), so reading today's settings
    # would make this test's answer depend on which machine runs it. The branch
    # under test is the fail-closed one: nothing can be signed by nothing.
    monkeypatch.setattr(settings, "better_auth_secret", "change-me-32-chars-min")
    with pytest.raises(HTTPException) as raised:
        await require_user_or_guest(
            guest_token=mint("change-me-32-chars-min", GUEST_ID),
            authorization=None,
            cookie=None,
            session=None,  # type: ignore[arg-type]
        )
    assert raised.value.status_code == 401
    assert raised.value.detail == "Authentication is not configured with a valid secret"


# --- 2. quota ---------------------------------------------------------------


def test_guest_quota_is_two_per_rolling_day(
    guest_quota: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    subject = f"guest:{GUEST_ID}"
    # Captured BEFORE the clock is replaced: the buckets below are stamped with
    # wall-clock time, so the "a day later" check has to advance from there — a
    # bare 86401 would be behind every stamp and prune nothing.
    start = time.time()
    rate_limit.check_guest_rate_limit(subject)
    rate_limit.check_guest_rate_limit(subject)

    with pytest.raises(HTTPException) as raised:
        rate_limit.check_guest_rate_limit(subject)
    assert raised.value.status_code == 429
    retry = int(raised.value.headers["Retry-After"])  # type: ignore[index]
    # The horizon must be real: a daily window means hours, not seconds.
    assert 3600 < retry <= 86400

    # ...and the window really is 24h, not the account's hourly one.
    monkeypatch.setattr(
        rate_limit, "time", types.SimpleNamespace(time=lambda: start + 86401.0)
    )
    rate_limit.check_guest_rate_limit(subject)


def test_the_instance_guest_budget_bounds_fresh_ids(
    guest_quota: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    # This is the bound that carries the cost guarantee: a new id per request is
    # what clearing a cookie buys, so only the instance budget stops it.
    monkeypatch.setattr(settings, "guest_scan_daily_total", 2)
    for index in range(2):
        rate_limit.check_guest_rate_limit(f"guest:{index:032x}")
    with pytest.raises(HTTPException) as raised:
        rate_limit.check_guest_rate_limit("guest:" + "a" * 32)
    assert raised.value.status_code == 429
    assert int(raised.value.headers["Retry-After"]) > 0  # type: ignore[index]


def test_guest_scans_are_charged_to_the_shared_shodan_budget(
    guest_quota: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A guest scan spends the same paid key, so RATE_LIMIT_DAILY_TOTAL applies
    # to it even while the guest-specific budget still has room.
    monkeypatch.setattr(settings, "guest_scan_daily_total", 0)  # guest cap off
    monkeypatch.setattr(settings, "rate_limit_daily_total", 1)
    rate_limit.check_guest_rate_limit(f"guest:{GUEST_ID}")
    with pytest.raises(HTTPException) as raised:
        rate_limit.check_guest_rate_limit(f"guest:{OTHER_GUEST_ID}")
    assert raised.value.status_code == 429


# --- 3. the endpoints -------------------------------------------------------


class _PersistRecorder:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def __call__(self, **kwargs) -> None:
        self.calls.append(kwargs)


@pytest.fixture
def guest_client(monkeypatch: pytest.MonkeyPatch, guest_secret: str, guest_quota: None):
    """POST /api/v1/scan over the REAL admission dependency.

    Only the DB write and the orchestrator fan-out are replaced: the first is
    storage, the second would otherwise contact Shodan/crt.sh/WHOIS for real.
    An IP-literal target keeps `assert_resolved_target_allowed` from resolving
    anything either.
    """
    from fastapi.testclient import TestClient

    from app.db.session import get_session
    from app.main import create_app
    from app.routers import scan as scan_router

    monkeypatch.setattr(settings, "rate_limit_per_hour", 100)
    recorder = _PersistRecorder()

    async def _run_scan(target, user_id, force=False, persist=None, **kwargs):
        payload = {
            "scan_id": "11111111-2222-3333-4444-555555555555",
            "target": target,
            "status": "partial",
            "risk_score": 12,
            "results": {"_risk_breakdown": {}},
            "errors": [{"source": "shodan", "message": "timeout"}],
        }
        if persist is not None:
            await persist(
                scan_id=payload["scan_id"],
                target=target,
                user_id=user_id,
                payload=payload,
            )
        return payload

    monkeypatch.setattr(scan_router.orchestrator, "run_scan", _run_scan)
    monkeypatch.setattr(scan_router, "_persist", recorder)

    app = create_app()
    app.dependency_overrides[get_session] = lambda: None
    with TestClient(app) as client:
        yield client, recorder
    app.dependency_overrides.clear()


def _headers(secret: str, guest_id: str = GUEST_ID) -> dict[str, str]:
    return {"x-guest-token": mint(secret, guest_id)}


def test_a_guest_scan_runs_and_is_stored_under_its_own_subject(guest_client) -> None:
    client, recorder = guest_client
    response = client.post(
        "/api/v1/scan",
        json={"target": "8.8.8.8"},
        headers=_headers(VALID_SECRET),
    )

    assert response.status_code == 200, response.text
    assert response.json()["status"] == "partial", "a source failure stays HTTP 200"
    assert recorder.calls, "the scan must have been persisted"
    assert recorder.calls[0]["user_id"] == f"guest:{GUEST_ID}"
    assert recorder.calls[0]["payload"]["errors"], "errors[] travels with a guest scan"


def test_the_third_guest_scan_of_the_day_is_429(guest_client) -> None:
    client, _ = guest_client
    for _ in range(2):
        ok = client.post(
            "/api/v1/scan",
            json={"target": "8.8.8.8"},
            headers=_headers(VALID_SECRET),
        )
        assert ok.status_code == 200

    refused = client.post(
        "/api/v1/scan",
        json={"target": "8.8.8.8"},
        headers=_headers(VALID_SECRET),
    )
    assert refused.status_code == 429
    assert int(refused.headers["Retry-After"]) > 0


def test_a_forged_token_cannot_start_a_scan(guest_client) -> None:
    client, recorder = guest_client
    forged_headers = {"x-guest-token": f"{GUEST_ID}.aaaa"}
    response = client.post(
        "/api/v1/scan", json={"target": "8.8.8.8"}, headers=forged_headers
    )

    assert response.status_code == 401
    assert recorder.calls == [], "a refused scan must never reach the orchestrator"


def test_no_token_means_no_scan(guest_client) -> None:
    client, recorder = guest_client
    response = client.post("/api/v1/scan", json={"target": "8.8.8.8"})

    assert response.status_code == 401
    assert recorder.calls == []


def test_disabling_the_quota_reads_as_401_not_429(
    guest_client, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, _ = guest_client
    monkeypatch.setattr(settings, "guest_scan_limit_per_day", 0)
    response = client.post(
        "/api/v1/scan", json={"target": "8.8.8.8"}, headers=_headers(VALID_SECRET)
    )

    assert response.status_code == 401


def test_history_stays_account_only(guest_client) -> None:
    # The scope half of the reversal: only /scan moved to the guest dependency.
    client, _ = guest_client
    response = client.get("/api/v1/history", headers=_headers(VALID_SECRET))

    assert response.status_code == 401


def test_account_subjects_still_go_through_the_hourly_quota(
    guest_client, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.core.security import require_user_or_guest as admission
    from app.routers import scan as scan_router

    client, _ = guest_client
    charged: list[str] = []
    monkeypatch.setattr(
        scan_router,
        "check_rate_limit",
        lambda subject: charged.append(f"account:{subject}"),
    )
    monkeypatch.setattr(
        scan_router,
        "check_guest_rate_limit",
        lambda subject: charged.append(f"guest:{subject}"),
    )

    original = client.app.dependency_overrides.get(admission)
    client.app.dependency_overrides[admission] = lambda: "user:alice"
    try:
        response = client.post(
            "/api/v1/scan",
            json={"target": "8.8.8.8"},
            headers=_headers(VALID_SECRET),
        )
    finally:
        if original is None:
            client.app.dependency_overrides.pop(admission, None)
        else:
            client.app.dependency_overrides[admission] = original

    assert response.status_code == 200, response.text
    assert charged == ["account:user:alice"], "an account must not spend guest quota"


# --- 4. ownership -----------------------------------------------------------


@pytest.mark.asyncio
async def test_a_guest_reads_only_scans_written_under_its_own_id() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as session:
        target = Target(id="target-guest", value="example.com", type="domain")
        session.add(target)
        session.add_all(
            [
                Scan(
                    id="scan-guest-a",
                    target_id=target.id,
                    user_id=f"guest:{GUEST_ID}",
                    status="completed",
                    risk_score=10,
                    result_snapshot={},
                    errors=[],
                    created_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
                ),
                Scan(
                    id="scan-guest-b",
                    target_id=target.id,
                    user_id=f"guest:{OTHER_GUEST_ID}",
                    status="completed",
                    risk_score=20,
                    result_snapshot={},
                    errors=[],
                    created_at=datetime(2026, 1, 2, tzinfo=timezone.utc),
                ),
                Scan(
                    id="scan-account",
                    target_id=target.id,
                    user_id="user:alice",
                    status="completed",
                    risk_score=30,
                    result_snapshot={},
                    errors=[],
                    created_at=datetime(2026, 1, 3, tzinfo=timezone.utc),
                ),
            ]
        )
        await session.commit()

        mine = await get_scan(
            "scan-guest-a", user_id=f"guest:{GUEST_ID}", session=session
        )
        assert mine.scan_id == "scan-guest-a"

        for foreign in ("scan-guest-b", "scan-account"):
            with pytest.raises(HTTPException) as raised:
                await get_scan(foreign, user_id=f"guest:{GUEST_ID}", session=session)
            assert raised.value.status_code == 404, foreign

        # The symmetric direction: an account cannot read a guest's scan either.
        with pytest.raises(HTTPException) as raised:
            await get_scan("scan-guest-a", user_id="user:alice", session=session)
        assert raised.value.status_code == 404

    await engine.dispose()
