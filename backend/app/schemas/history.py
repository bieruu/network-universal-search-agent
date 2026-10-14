"""Response models for the history endpoints.

These existed as bare dicts before, which meant the generated OpenAPI showed
`{"items": [...], "total": ...}` with no idea what an item was — the endpoints
a dashboard polls most often were the least documented part of the API.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

ScanStatus = Literal["pending", "running", "completed", "partial", "failed"]


class HistoryItem(BaseModel):
    """One stored scan in the caller's own history."""

    scan_id: str
    target: str
    status: ScanStatus
    risk_score: int | None = None
    created_at: str | None = None


class HistoryResponse(BaseModel):
    """A page of the caller's scans, newest first."""

    items: list[HistoryItem] = []
    total: int = 0
    page: int = Field(default=1, ge=1)
    limit: int = Field(default=20, ge=1, le=100)


class TrendPoint(BaseModel):
    """One scan's score on the risk trend line."""

    scan_id: str
    created_at: str | None = None
    risk_score: int | None = None


class TrendResponse(BaseModel):
    """Up to the ten most recent scans for one target, oldest point first."""

    target: str
    points: list[TrendPoint] = []
