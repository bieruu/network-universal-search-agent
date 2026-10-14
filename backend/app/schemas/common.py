"""Shared Pydantic models: the per-source error entry and the error bodies.

`SourceError` is the shape every partial failure returns inside a scan or an
analysis response: HTTP 200 with an entry in `errors[]` (AGENTS.md §5.4). The
`ErrorResponse` / `ValidationErrorResponse` models are the *exception* bodies —
the only 4xx/5xx this API answers with — and they exist so the generated
OpenAPI documents them instead of leaving a caller to discover them.

Every `HTTPException` in this codebase raises `detail` as a plain string, so
`ErrorResponse` is exact. Request validation is the one different shape:
FastAPI answers 422 with a list of `{loc, msg, type}` entries, and documenting
that as a string would make the schema lie about the one error a caller is
most likely to hit.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class SourceError(BaseModel):
    """One source that failed while the request as a whole succeeded."""

    source: str
    message: str = Field(
        description="User-facing reason; never a raw exception or a key."
    )


class ErrorResponse(BaseModel):
    """The `{"detail": "..."}` body of every HTTPException this API raises."""

    detail: str


class ValidationErrorItem(BaseModel):
    """One field-level problem in a rejected request body."""

    loc: list[str | int]
    msg: str
    type: str


class ValidationErrorResponse(BaseModel):
    """FastAPI's 422 body: a list, not a string, because the body is the problem."""

    detail: list[ValidationErrorItem]


# What each documented status means, in one place, so the wording is identical
# everywhere the schema mentions it. Written for a caller reading /docs, which
# is the only contract a public deployment ever shows them.
_ERROR_BODIES: dict[int, tuple[type[BaseModel], str]] = {
    400: (
        ErrorResponse,
        "Refused by policy: a private/localhost target, a malformed URL, or a caller mistake the service can name.",
    ),
    401: (
        ErrorResponse,
        "No valid session: the cookie or bearer token was missing, invalid, or expired. Every scan/history/analysis endpoint requires one.",
    ),
    404: (ErrorResponse, "No such record — an unknown scan id, for example."),
    413: (ErrorResponse, "The request body exceeded the configured size cap."),
    422: (
        ValidationErrorResponse,
        "Request validation failed: the body did not match the request model. The detail list names the fields.",
    ),
    429: (
        ErrorResponse,
        "Rate limit exceeded — the per-account hourly quota, the instance daily cap, or the live-key ceiling. The `Retry-After` header says when to try again.",
    ),
    503: (
        ErrorResponse,
        "A dependency is not configured or not reachable — an unconfigured session store, for instance.",
    ),
}


def error_responses(*codes: int) -> dict[int | str, dict[str, Any]]:
    """OpenAPI `responses=` entries for the statuses this API can answer with.

    Documenting them is the point of the OpenAPI work: without it the generated
    schema shows only the happy path, and a caller of a public deployment has
    no way to learn that a partial failure is HTTP 200 with `errors[]` rather
    than a 5xx — which is the single most surprising thing about this API.
    """
    return {
        code: {"model": _ERROR_BODIES[code][0], "description": _ERROR_BODIES[code][1]}
        for code in codes
    }
