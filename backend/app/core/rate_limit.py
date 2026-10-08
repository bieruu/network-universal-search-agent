"""In-memory per-user fixed-window rate limiter (5/hour default).

Two bounds sit on top of the hourly window: an absolute ceiling on live bucket
keys (memory) and an opt-in instance-wide daily cap (cost).
"""

from __future__ import annotations

import logging
import time
from collections import defaultdict

from fastapi import HTTPException, Request

from app.core.config import settings

log = logging.getLogger(__name__)

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


def _is_exempt(user_id: str) -> bool:
    """True when this subject is exempt from the rate-limit buckets.

    Reads `settings.rate_limit_exempt_subjects` (comma-separated exact
    subjects) on every call rather than caching the parsed set, so toggling the
    setting takes effect without a restart — which is the whole point for a
    testing switch. The list is tiny, so re-parsing is cheaper than a stale
    decision.

    WHY THE SUBJECT, NOT A USER FLAG
    --------------------------------
    `require_user()` returns exactly two shapes: `user:<db-id>` for a session
    cookie, and `user:service` for `Authorization: Bearer <SERVICE_TOKEN>`
    compared with hmac.compare_digest. Exempting by subject therefore exempts
    the *service* identity, which needs a secret that never reaches a browser.

    Exempting a browser subject instead would be a real vulnerability: any
    stolen cookie or XSS would become an unlimited draw on the single paid
    Shodan key. The per-user quota exists precisely so one compromised account
    cannot become a cost vector, and an exemption that a cookie can carry
    deletes that protection.

    Consequently, a `user:<db-id>` subject is only exempt if an operator
    deliberately puts that exact id in the setting — never by accident, and
    never by inference. `tests/test_rate_limit_exempt.py` pins this.
    """
    raw = getattr(settings, "rate_limit_exempt_subjects", "") or ""
    subject = (user_id or "").strip()
    if not subject:
        return False
    for candidate in str(raw).split(","):
        entry = candidate.strip()
        # Exact match, never a prefix: `user:service` must not exempt
        # `user:service-admin`, and a bare `user:` prefix must match nothing.
        if entry and entry == subject:
            log.warning(
                "rate_limit_exempt subject=%s bucket=unlimited — "
                "this request was NOT charged to any quota",
                subject,
            )
            return True
    return False


def check_rate_limit(user_id: str) -> None:
    """Charge one scan against the per-account quota and the instance budget.

    This bucket is bound to the shared PAID Shodan key (see PRODUCTION_RATE_
    LIMIT_CEILING in config.py), which is why it also bills the instance-wide
    daily cap. Free or offline capabilities must NOT reuse it — see
    `check_free_rate_limit`, which exists because aliasing this one would both
    spend a scan's quota on work that costs nothing and let a contact lookup
    consume the scan budget that is supposed to bound active fan-out.
    """
    global _last_sweep
    if _is_exempt(user_id):
        return
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


def check_free_rate_limit(user_id: str, scope: str) -> None:
    """Per-account quota for a capability that costs no Shodan credit.

    Deliberately a separate counter with its own key namespace, not a parameter
    on `check_rate_limit`. Three reasons, each of which is a real regression if
    aliased:

      1. The hourly quota is a BILLING decision about one shared paid key. An
         offline phone parse or a contact fetch draws no Shodan query, so
         charging it there burns real money budget on free work — and, worse,
         lets a cheap endpoint consume the quota meant to bound active fan-out.
      2. Coupling them means an address-harvesting primitive can exhaust a
         user's *scan* allowance, turning a bounded fetch into a denial of the
         core product.
      3. `rate_limit_max_keys` is fail-closed by design: once the live key map
         is full, NEW keys get a 429 that is byte-identical to a quota
         rejection. A second feature roughly doubles key-creation rate against
         that shared map, so live accounts hit the ceiling more often.

    Sharing the module's sweep and the absolute key ceiling is still correct:
    one amortized O(#keys) pass, one memory bound, one fail-closed policy. Only
    the quota and the keyspace are separate. The instance daily cap is NOT
    applied here — that cap exists to bound spend on the paid key.
    """
    global _last_sweep
    if _is_exempt(user_id):
        return
    now = time.time()
    window = 3600.0
    limit = settings.free_rate_limit_per_hour
    if now - _last_sweep >= _SWEEP_INTERVAL:
        _last_sweep = now
        _sweep_expired(now, window)
        _prune_instance(now)

    # Fail closed, never evict: see the reasoning in check_rate_limit. LRU
    # eviction would hand the caller a fresh quota.
    if user_id not in _buckets and len(_buckets) >= settings.rate_limit_max_keys:
        retry = max(1, int(_SWEEP_INTERVAL - (now - _last_sweep)) + 1)
        raise HTTPException(
            status_code=429,
            detail="Rate limit exceeded",
            headers={"Retry-After": str(retry)},
        )

    key = f"free:{scope}:{user_id}"
    stamps = [t for t in _buckets[key] if now - t < window]
    _buckets[key] = stamps
    if len(stamps) >= limit:
        retry = int(window - (now - stamps[0])) + 1
        raise HTTPException(
            status_code=429,
            detail="Rate limit exceeded",
            headers={"Retry-After": str(retry)},
        )
    stamps.append(now)


def reset_for_tests() -> None:
    global _last_sweep
    _buckets.clear()
    _instance.clear()
    # Zeroed so the next call sweeps even when a test clock starts near 0.
    _last_sweep = 0.0
