"""In-memory per-user fixed-window rate limiter (5/hour default).

Two bounds sit on top of the hourly window: an absolute ceiling on live bucket
keys (memory) and an opt-in instance-wide daily cap (cost).
"""

from __future__ import annotations

import time
from collections import defaultdict

from fastapi import HTTPException, Request

from app.core.config import settings

_buckets: dict[str, list[float]] = defaultdict(list)
# A bucket is only pruned when that *same* user calls again, so a user who scans
# once and never returns leaks its key until the process restarts. With open
# sign-up that growth is unbounded over the container's lifetime, so a periodic
# sweep caps it at "keys live within the last window + interval". Redis/Postgres
# is the real fix but is v2 (see TODO Backlog). Wall clock, not monotonic, so the
# sweep guard ages exactly like the stamps it prunes.
_last_sweep: float = 0.0
_SWEEP_INTERVAL = 300.0

_HOUR = 3600.0
_DAILY_WINDOW = 24.0 * _HOUR
# Instance-wide counter for the optional daily cap: hour index -> scans admitted
# in that hour. Hour buckets (not raw stamps) keep this map at <= 25 entries no
# matter how many scans run, so the cost backstop can never become the unbounded
# growth the per-key ceiling exists to prevent.
_instance: dict[int, int] = {}


def _sweep_expired(now: float, window: float) -> None:
    """Delete buckets whose newest stamp already fell out of the window.

    Only fully expired buckets go: one live stamp keeps the bucket (and its
    remaining quota) intact. max() rather than stamps[-1] because a backwards
    clock jump can leave the stamps unsorted. O(#keys) — callers must amortize.
    """
    expired = [
        k for k, stamps in _buckets.items() if now - max(stamps, default=0.0) >= window
    ]
    for key in expired:
        del _buckets[key]


def _prune_instance(now: float) -> None:
    """Drop hourly counters that fell out of the rolling daily window.

    O(#hours), so it is safe on the same amortized schedule as _sweep_expired.
    """
    oldest = int((now - _DAILY_WINDOW) // _HOUR) + 1
    for key in [k for k in _instance if k < oldest]:
        del _instance[key]


def _check_instance_daily_cap(now: float, cap: int) -> None:
    """Refuse a scan when the instance has already spent its 24h budget.

    The hourly quota is per account and cannot express "this one paid Shodan key
    must not draw more than X per day" — N accounts each inside their own quota
    still add up, and the sign-up gate is an admission control, not a budget.
    cap <= 0 disables the cap, which is the default so nothing changes for
    deployments that do not opt in.
    """
    if cap <= 0:
        return
    oldest = int((now - _DAILY_WINDOW) // _HOUR) + 1
    used = sum(count for k, count in _instance.items() if k >= oldest)
    if used < cap:
        return
    # Retry-After points at the hour bucket that pushed the running total over
    # the cap: it stops counting once it ages out of the window. Hour buckets mean
    # the window spans between 23 and 25 hours of traffic, so the hint is
    # conservative rather than exact.
    running = 0
    culprit = oldest
    for key in sorted(k for k in _instance if k >= oldest):
        running += _instance[key]
        if running >= cap:
            culprit = key
            break
    retry = max(1, int(culprit * _HOUR + _DAILY_WINDOW - now) + 1)
    raise HTTPException(
        status_code=429,
        detail="Rate limit exceeded",
        headers={"Retry-After": str(retry)},
    )


def _count_instance(now: float) -> None:
    """Bill one admitted scan against the instance daily budget.

    Called only after the per-account check has already passed, so the budget
    tracks real Shodan spend and a request that never ran does not consume it.
    """
    hour = int(now // _HOUR)
    _instance[hour] = _instance.get(hour, 0) + 1


def check_rate_limit(user_id: str) -> None:
    global _last_sweep
    now = time.time()
    window = 3600.0
    limit = settings.rate_limit_per_hour
    if now - _last_sweep >= _SWEEP_INTERVAL:
        # Amortized: one O(#keys) scan per interval instead of one per request.
        _last_sweep = now
        _sweep_expired(now, window)
        _prune_instance(now)
    # Absolute ceiling on live keys. Policy: FAIL CLOSED, do not evict.
    # Evicting the least-recently-used bucket to make room would hand that user a
    # fresh quota, so anyone able to create keys could mint extra scans against a
    # paid key — the sweep's LRU-by-newest-stamp ordering makes it worse, because
    # the flood victims are exactly the newest keys, i.e. live users. A quota
    # bypass costs money; locking out *unknown* keys costs at most one
    # _SWEEP_INTERVAL of new signups, cannot touch a bucket that already exists
    # (so no live account loses quota), and matches AGENTS.md's "fail closed".
    # The 429 body is identical to a quota rejection on purpose: a different
    # detail would hand an attacker a probe for how full the map is.
    if user_id not in _buckets and len(_buckets) >= settings.rate_limit_max_keys:
        retry = max(1, int(_SWEEP_INTERVAL - (now - _last_sweep)) + 1)
        raise HTTPException(
            status_code=429,
            detail="Rate limit exceeded",
            headers={"Retry-After": str(retry)},
        )
    _check_instance_daily_cap(now, settings.rate_limit_daily_total)
    stamps = [t for t in _buckets[user_id] if now - t < window]
    _buckets[user_id] = stamps
    if len(stamps) >= limit:
        retry = int(window - (now - stamps[0])) + 1
        raise HTTPException(
            status_code=429,
            detail="Rate limit exceeded",
            headers={"Retry-After": str(retry)},
        )
    stamps.append(now)
    _count_instance(now)


def rate_limit(request: Request, user_id: str) -> None:
    _ = request
    check_rate_limit(user_id)


def reset_for_tests() -> None:
    global _last_sweep
    _buckets.clear()
    _instance.clear()
    # Zeroed so the next call sweeps even when a test clock starts near 0.
    _last_sweep = 0.0
