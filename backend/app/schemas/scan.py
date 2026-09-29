from __future__ import annotations

from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field

TARGET_RE = r"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$|^(?:\d{1,3}\.){3}\d{1,3}$"


class ScanRequest(BaseModel):
    target: str = Field(pattern=TARGET_RE, min_length=3, max_length=253)
    force: bool = False


class ScanResponse(BaseModel):
    scan_id: UUID
    target: str
    status: Literal["pending", "running", "completed", "partial", "failed"]
    risk_score: int | None = None
    results: dict[str, Any] = {}
    errors: list[dict[str, str]] = []
