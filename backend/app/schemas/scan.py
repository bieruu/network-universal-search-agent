from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.common import SourceError
from app.schemas.dns import DnsLookupResult

TARGET_RE = (
    r"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$|^(?:\d{1,3}\.){3}\d{1,3}$"
)

ScanStatus = Literal["pending", "running", "completed", "partial", "failed"]


class ScanRequest(BaseModel):
    target: str = Field(pattern=TARGET_RE, min_length=3, max_length=253)
    force: bool = False


class ScanResults(BaseModel):
    """The per-source blocks of a scan snapshot.

    Only the DNS block is typed. The rest stay free-form on purpose: every
    other source's payload is bounded, truncated and shaped by its own
    service, and validating third-party bytes here would mean trusting a
    third party to have stayed inside a schema (AGENTS.md §5.4). `extra` is
    allowed so the response surface passes those blocks through unchanged
    rather than dropping what it does not recognise — a lossy response model
    is a dishonest one. `dns` is typed because it is the one block whose
    contract this repo owns end to end.
    """

    model_config = ConfigDict(extra="allow")

    dns: DnsLookupResult | None = None


class ScanAcceptedResponse(BaseModel):
    """POST /api/v1/scan: the scan was accepted and is already running.

    Poll `GET /api/v1/scan/{scan_id}` for the result — the accepted response
    carries the id and the initial status, never the findings.
    """

    scan_id: str = Field(
        description=(
            "Identifier to poll with GET /api/v1/scan/{scan_id}. The app "
            "generates a UUID string; the column is a plain String(36), so the "
            "type here mirrors storage rather than the generator — a response "
            "model must never be able to 500 a read of a stored row."
        )
    )
    status: ScanStatus


class ScanDetailResponse(BaseModel):
    """GET /api/v1/scan/{scan_id}: one stored scan, including partial results.

    `status` is `partial` when at least one source answered and at least one
    failed; `failed` when none did. A failed source is an entry in `errors` —
    the response itself is still HTTP 200, because a scan that lost one source
    is a usable result, not a server fault.
    """

    scan_id: str
    target: str
    status: ScanStatus
    risk_score: int | None = None
    results: ScanResults = ScanResults()
    errors: list[SourceError] = []
