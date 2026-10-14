"""Response models for the health endpoints.

`/health` and `/ready` stay exactly as unauthenticated as they were — they are
liveness and readiness probes for a load balancer and a keep-alive ping, and
locking them would break both. `/health/sources` is the one that is gated (see
source_health_service for why), and it is the one worth documenting: its
statuses are a vocabulary, not booleans, and a client rendering them needs to
know that `unknown` is not `down`.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


class HealthResponse(BaseModel):
    """Liveness. No DB, no source, no probe — just "the process is up"."""

    status: str


class ReadyResponse(BaseModel):
    """Readiness. `degraded` means the database ping failed."""

    status: str


class SourceStatus(BaseModel):
    """One external source's probe result.

    `status` is deliberately a three-word vocabulary instead of a boolean
    "up/down": `unknown` is the honest answer when a probe establishes
    nothing, and collapsing it into either boolean would be a claim the probe
    cannot support.
    """

    source: str
    status: Literal["ok", "degraded", "unknown"]
    detail: str = ""


class SourceHealthResponse(BaseModel):
    """Per-source reachability, cached behind a TTL.

    `cached` says whether this answer came from the cache; `checked_at` is when
    the probes actually ran. A client must render the timestamp alongside the
    status, or a ten-minute-old `ok` reads as a live guarantee.
    """

    sources: dict[str, SourceStatus]
    checked_at: str
    cached: bool = False
    note: str = ""
