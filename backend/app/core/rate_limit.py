"""In-memory per-user fixed-window rate limiter (10/hour default)."""

from __future__ import annotations

import time
from collections import defaultdict

from fastapi import HTTPException, Request

from app.core.config import settings

_buckets: dict[str, list[float]] = defaultdict(list)


def check_rate_limit(user_id: str) -> None:
    now = time.time()
    window = 3600.0
    limit = settings.rate_limit_per_hour
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


def rate_limit(request: Request, user_id: str) -> None:
    _ = request
    check_rate_limit(user_id)


def reset_for_tests() -> None:
    _buckets.clear()
