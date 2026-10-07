"""Rate limiter bucket eviction, key ceiling and instance cap.

Time is injected, never slept: `rate_limit.time` is swapped for a fake clock so
the sweep interval and the 1h window are exercised deterministically. The only
observable proof of eviction is the internal `_buckets` dict — assert on it
directly rather than on call outcomes, which a stale key and a fresh key share.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from app.core import rate_limit

WINDOW = 3600.0
T0 = 1_700_000_000.0  # realistic epoch so "far in the past" actually reads as past


class _Clock:
    """Stand-in for the `time` module: only `time()` is used by rate_limit."""

    def __init__(self, start: float = T0) -> None:
        self.now = start

    def time(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


@pytest.fixture
def clock(monkeypatch) -> _Clock:
    c = _Clock()
    monkeypatch.setattr(rate_limit, "time", c)
    rate_limit.reset_for_tests()
    yield c
    rate_limit.reset_for_tests()


@pytest.fixture
def sweep_calls(monkeypatch) -> list[float]:
    """Wrap _sweep_expired so tests can count how often it actually runs."""
    calls: list[float] = []
    real = rate_limit._sweep_expired

    def counting(now: float, window: float) -> None:
        calls.append(now)
        real(now, window)

    monkeypatch.setattr(rate_limit, "_sweep_expired", counting)
    return calls


@pytest.fixture
def limit(monkeypatch):
    def _set(value: int) -> None:
        monkeypatch.setattr(rate_limit.settings, "rate_limit_per_hour", value)

    return _set


@pytest.fixture
def max_keys(monkeypatch):
    """Set the absolute ceiling on live bucket keys (RATE_LIMIT_MAX_KEYS)."""

    def _set(value: int) -> None:
        monkeypatch.setattr(rate_limit.settings, "rate_limit_max_keys", value)

    return _set


@pytest.fixture
def daily_cap(monkeypatch):
    """Set the opt-in instance-wide 24h scan budget (RATE_LIMIT_DAILY_TOTAL)."""

    def _set(value: int) -> None:
        monkeypatch.setattr(rate_limit.settings, "rate_limit_daily_total", value)

    return _set


def test_fully_expired_bucket_is_evicted(clock: _Clock):
    """A user who scans once and never returns must not keep its key forever."""
    rate_limit.check_rate_limit("ghost")
    assert "ghost" in rate_limit._buckets

    clock.advance(WINDOW + 100)
    rate_limit.check_rate_limit("live")  # any call sweeps once the interval passed

    assert "ghost" not in rate_limit._buckets
    assert "live" in rate_limit._buckets


def test_active_bucket_survives_sweep_and_stays_limited(clock: _Clock, limit):
    """Mid-window user keeps its key and its quota; the sweep must not free it."""
    limit(2)
    rate_limit.check_rate_limit("busy")
    clock.advance(100)
    rate_limit.check_rate_limit("busy")

    clock.advance(WINDOW - 200)  # newest stamp is 100s old, still inside window
    rate_limit.check_rate_limit("sweeper")  # forces a sweep

    assert "busy" in rate_limit._buckets
    assert len(rate_limit._buckets["busy"]) == 2
    with pytest.raises(HTTPException) as e:
        rate_limit.check_rate_limit("busy")
    assert e.value.status_code == 429


def test_sweep_is_amortized_not_per_request(clock: _Clock, sweep_calls):
    """Guard: a burst of requests inside one interval scans the dict once."""
    rate_limit.check_rate_limit("a")  # first call after reset sweeps (guard armed)
    assert len(sweep_calls) == 1

    for i in range(50):
        clock.advance(1)
        rate_limit.check_rate_limit(f"u{i}")
    assert len(sweep_calls) == 1  # 50s of traffic, all inside the same interval

    clock.advance(rate_limit._SWEEP_INTERVAL)
    rate_limit.check_rate_limit("trigger")
    assert len(sweep_calls) == 2


def test_reset_for_tests_clears_buckets_and_sweep_state(clock: _Clock, sweep_calls):
    rate_limit.check_rate_limit("ghost")
    rate_limit._last_sweep = clock.now  # pretend a sweep just ran at this instant
    assert rate_limit._buckets and rate_limit._last_sweep != 0.0

    rate_limit.reset_for_tests()
    before = len(sweep_calls)

    assert dict(rate_limit._buckets) == {}
    assert rate_limit._last_sweep == 0.0
    # Guard is re-armed: the next call sweeps again even though a sweep had
    # already run at this same clock value. Without the reset, _last_sweep would
    # still be clock.now and the guard would swallow the sweep (state leaks
    # between tests).
    rate_limit.check_rate_limit("next")
    assert len(sweep_calls) == before + 1


def test_429_detail_and_retry_after_unchanged(clock: _Clock, limit):
    """Regression: the eviction work must not move the 429 contract."""
    limit(2)
    rate_limit.check_rate_limit("u")  # t = T0
    clock.advance(100)
    rate_limit.check_rate_limit("u")  # t = T0 + 100
    clock.advance(200)

    with pytest.raises(HTTPException) as e:
        rate_limit.check_rate_limit("u")  # t = T0 + 300, oldest stamp at T0
    assert e.value.status_code == 429
    assert e.value.detail == "Rate limit exceeded"
    # int(window - (now - stamps[0])) + 1, with now - stamps[0] == 300.
    assert e.value.headers == {"Retry-After": str(int(WINDOW - 300) + 1)}


def test_sweep_boundary_matches_prune_filter(clock: _Clock, limit):
    """Eviction must not free a quota the prune filter still counts as live.

    The sweep drops a key once its *newest* stamp is prunable; the prune filter
    keeps stamps while now - t < window. At the exact boundary the two agree, so
    an evicted key is one the user would have started empty with anyway.
    """
    limit(1)
    rate_limit.check_rate_limit("edge")  # t = T0
    clock.advance(WINDOW)  # now - t == window exactly
    rate_limit.check_rate_limit("sweeper")

    assert "edge" not in rate_limit._buckets
    rate_limit.check_rate_limit("edge")  # clean slate, no free extra scan
    assert rate_limit._buckets["edge"] == [clock.now]


# --- absolute ceiling on live bucket keys -------------------------------------
#
# The sweep only bounds growth relative to arrival rate ("keys touched in the
# last ~65 minutes"), so a burst of distinct sign-ups inside one window still
# parked one key each. RATE_LIMIT_MAX_KEYS is the absolute bound.


def test_key_ceiling_bounds_the_map(clock: _Clock, limit, max_keys):
    """50 distinct users against a ceiling of 5 must leave exactly 5 keys."""
    limit(1000)
    max_keys(5)

    for i in range(50):
        clock.advance(1)
        try:
            rate_limit.check_rate_limit(f"u{i}")
        except HTTPException as e:
            assert e.status_code == 429

    assert len(rate_limit._buckets) == 5
    assert len(rate_limit._buckets) <= 5


def test_capacity_rejection_is_429_and_evicts_nothing(clock: _Clock, limit, max_keys):
    """Policy: fail closed. An unknown key at the ceiling is refused, not swapped
    for someone else's bucket, so no existing key is silently freed."""
    limit(1)
    max_keys(2)
    rate_limit.check_rate_limit("a")
    clock.advance(1)
    rate_limit.check_rate_limit("b")

    with pytest.raises(HTTPException) as e:
        rate_limit.check_rate_limit("c")
    assert e.value.status_code == 429
    # Same body as a quota rejection on purpose: a distinct detail would be an
    # oracle telling an attacker how full the map is.
    assert e.value.detail == "Rate limit exceeded"
    # 1s has passed since the sweep that armed the guard, so the next reclaim is
    # _SWEEP_INTERVAL - 1 seconds away.
    assert e.value.headers == {
        "Retry-After": str(int(rate_limit._SWEEP_INTERVAL - 1) + 1)
    }
    assert "c" not in rate_limit._buckets
    # No LRU eviction: the two live buckets are untouched.
    assert set(rate_limit._buckets) == {"a", "b"}
    assert rate_limit._buckets["a"] == [T0]


def test_capacity_pressure_never_grants_extra_quota(clock: _Clock, limit, max_keys):
    """The eviction alternative would hand a limited victim a fresh quota here.

    A flood of new keys must not reset the bucket of a user who is already over
    their hourly limit — that would turn memory pressure into free scans against
    a paid key.
    """
    limit(2)
    max_keys(1)
    rate_limit.check_rate_limit("victim")
    rate_limit.check_rate_limit("victim")

    for i in range(20):
        with pytest.raises(HTTPException) as e:
            rate_limit.check_rate_limit(f"flood{i}")
        assert e.value.status_code == 429

    assert set(rate_limit._buckets) == {"victim"}
    with pytest.raises(HTTPException) as e:
        rate_limit.check_rate_limit("victim")
    assert e.value.status_code == 429
    assert e.value.detail == "Rate limit exceeded"
    # Still exactly the stamps it spent, i.e. the flood bought it nothing.
    assert len(rate_limit._buckets["victim"]) == 2


def test_capacity_retry_after_is_bounded_by_the_sweep_interval(
    clock: _Clock, limit, max_keys
):
    """The hint must point at the next sweep, not at an hour away."""
    limit(1)
    max_keys(1)
    rate_limit.check_rate_limit("a")  # arms _last_sweep at T0

    clock.advance(rate_limit._SWEEP_INTERVAL - 1)  # just before the next sweep
    with pytest.raises(HTTPException) as e:
        rate_limit.check_rate_limit("b")

    assert e.value.headers == {"Retry-After": "2"}


def test_capacity_recovers_when_the_sweep_reclaims_space(
    clock: _Clock, limit, max_keys
):
    """Fail-closed must be temporary: expired keys are reclaimed by the sweep."""
    limit(1)
    max_keys(2)
    rate_limit.check_rate_limit("a")
    clock.advance(1)
    rate_limit.check_rate_limit("b")
    with pytest.raises(HTTPException):
        rate_limit.check_rate_limit("c")
    assert "c" not in rate_limit._buckets

    clock.advance(WINDOW + rate_limit._SWEEP_INTERVAL)  # sweep fires, keys expired
    rate_limit.check_rate_limit("c")

    assert "c" in rate_limit._buckets
    assert set(rate_limit._buckets) == {"c"}


# --- opt-in instance-wide daily cost cap --------------------------------------


def test_daily_cap_zero_is_disabled(clock: _Clock, limit, daily_cap):
    """Default 0 = off: without an operator budget, no global bound applies."""
    limit(2)
    daily_cap(0)

    for i in range(20):
        rate_limit.check_rate_limit(f"u{i}")
        rate_limit.check_rate_limit(f"u{i}")

    assert len(rate_limit._buckets) == 20


def test_daily_cap_bounds_scans_across_accounts(clock: _Clock, limit, daily_cap):
    """The per-account quota cannot express a budget for the shared Shodan key:
    5/hour per user still adds up, so the instance cap must be able to stop it."""
    limit(5)  # generous per-account quota on purpose
    daily_cap(3)

    for i in range(3):
        rate_limit.check_rate_limit(f"u{i}")

    with pytest.raises(HTTPException) as e:
        rate_limit.check_rate_limit("u3")
    assert e.value.status_code == 429
    assert e.value.detail == "Rate limit exceeded"
    # Retry-After = the moment the hour bucket that filled the budget ages out of
    # the 24h window: culprit_hour * 3600 + 86400 - now + 1.
    hour = int(T0 // 3600)
    assert e.value.headers == {"Retry-After": str(hour * 3600 + 86400 - int(T0) + 1)}
    assert 0 < int(e.value.headers["Retry-After"]) <= 86400 + 3600
    # Rejection happens before the per-account bucket is created.
    assert "u3" not in rate_limit._buckets


def test_daily_cap_rejection_does_not_spend_account_quota(
    clock: _Clock, limit, daily_cap
):
    """A globally refused scan never ran, so it must not burn the user's stamps."""
    limit(5)
    daily_cap(1)
    rate_limit.check_rate_limit("u")  # fills the instance budget

    with pytest.raises(HTTPException):
        rate_limit.check_rate_limit("u")

    assert rate_limit._buckets["u"] == [clock.now]


def test_daily_cap_counts_only_admitted_scans(clock: _Clock, limit, daily_cap):
    """A request the hourly limiter refused cost no Shodan query, so it must not
    consume the instance budget either."""
    limit(1)
    daily_cap(3)
    rate_limit.check_rate_limit("u")  # admitted, budget 1/3
    with pytest.raises(HTTPException):
        rate_limit.check_rate_limit("u")  # hourly rejection, not billed

    rate_limit.check_rate_limit("other0")  # 2/3 — proof the refusal cost nothing
    rate_limit.check_rate_limit("other1")  # 3/3

    with pytest.raises(HTTPException) as e:
        rate_limit.check_rate_limit("other2")
    assert e.value.status_code == 429


def test_daily_cap_relaxes_as_hours_age_out(clock: _Clock, limit, daily_cap):
    """The budget must actually roll: 24h later the same instance is usable."""
    limit(5)
    daily_cap(2)
    rate_limit.check_rate_limit("a")
    rate_limit.check_rate_limit("b")
    with pytest.raises(HTTPException):
        rate_limit.check_rate_limit("c")

    clock.advance(86400 + 10)

    rate_limit.check_rate_limit("c")
    assert "c" in rate_limit._buckets


def test_daily_cap_counters_stay_bounded_over_two_days(clock: _Clock, limit, daily_cap):
    """Hour buckets, not raw stamps: two days of traffic must stay tiny."""
    limit(1000)
    daily_cap(0)  # cap off so every call is admitted and counted

    for day in range(2):
        for hour in range(24):
            clock.advance(3600)
            rate_limit.check_rate_limit(f"u{day}-{hour}")

    assert len(rate_limit._instance) <= 25


def test_reset_for_tests_clears_the_instance_counter(clock: _Clock, daily_cap):
    """Otherwise a spent budget leaks between tests (and the map never reclaims)."""
    daily_cap(1)
    rate_limit.check_rate_limit("u")
    assert rate_limit._instance

    rate_limit.reset_for_tests()

    assert rate_limit._instance == {}
