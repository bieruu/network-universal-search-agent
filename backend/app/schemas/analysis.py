"""Request/response shapes for the v2 analysis capabilities.

Deliberately thin: the services return plain dicts that are already bounded and
truncated, so these models validate the INPUT (the part a caller controls) and
the shape of the envelope, not every field of every source payload. Validating
upstream-derived data here would mean trusting a third party to have stayed
inside a schema, which is the assumption AGENTS.md §5.4 forbids.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

# A target the backend will CONNECT to. Deliberately looser than the scan
# target pattern: these endpoints take a full URL, and the SSRF guard
# (app/core/ssrf.py) is the component that actually decides what is fetchable.
# Validating the shape here keeps obvious garbage out; it is not the security
# boundary, and nothing in this file should be mistaken for one.
ANALYSIS_TARGET_MAX = 2048


class UrlAnalysisRequest(BaseModel):
    """A URL for a capability that fetches the target (behind the SSRF guard)."""

    url: str = Field(min_length=8, max_length=ANALYSIS_TARGET_MAX)
    force: bool = False


class DomainAnalysisRequest(BaseModel):
    """A bare domain/IP for a capability that queries a data source."""

    target: str = Field(min_length=3, max_length=253)
    force: bool = False


class PhoneLookupRequest(BaseModel):
    """Phone validation input.

    The 100-item cap is enforced HERE, at the schema layer, not only in the
    service: a 5000-line paste must be rejected before it is parsed, and the
    service still reports counts_truncated so the UI can say "showing 100 of
    150" rather than silently capping.
    """

    number: str = Field(min_length=1, max_length=64)
    region: str | None = Field(default=None, min_length=2, max_length=2)


class PhoneBulkRequest(BaseModel):
    numbers: list[str] = Field(min_length=1, max_length=100)
    region: str | None = Field(default=None, min_length=2, max_length=2)


class AnalysisResponse(BaseModel):
    """Envelope every analysis endpoint returns.

    `capability` names the block, `source` is that block's own self-description,
    and `errors` carries per-source failures. A failure is HTTP 200 with an
    entry in `errors` — a blocked or unreachable target must never present as a
    500 (AGENTS.md §5.4). A genuine caller mistake (malformed input) is the one
    case that answers 4xx, and that is decided by validation before here.
    """

    capability: str
    target: str
    source: str = ""
    status: str = "ok"
    data: dict[str, Any] = {}
    errors: list[dict[str, str]] = []
    fetched_at: str
