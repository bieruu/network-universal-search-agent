"""User-safe error strings, shared by every service.

Lives in `core/` rather than `services/orchestrator.py` because services need it
too, and a service importing the orchestrator inverts the dependency: the
orchestrator imports the services, so `urlscan_service` reaching back into it is
a circular import that fails at collection time.

`sanitize_error` is the single place that decides what an upstream failure is
allowed to say to a client. It strips anything shaped like an API key, because
an exception message can contain the full request URL and a key in a query
string would otherwise land in a response body, a log line, and
`scans.result_snapshot` (AGENTS.md §5.1).
"""

from __future__ import annotations

import asyncio
import re

# Matches a key in a query string, however it is spelled. Broad on purpose: a
# false positive costs a user one redacted word, a false negative leaks a secret.
_KEY_RE = re.compile(r"([?&](?:key|api[_-]?key|apikey|token)=)[^&\s]+", re.IGNORECASE)
_BARE_KEY_RE = re.compile(r"\b(?:key|api[_-]?key|apikey|token)=\S+", re.IGNORECASE)


def sanitize_error(source: str, e: BaseException) -> str:
    """Build a user-safe error message. Never leaks query params (API keys)."""
    status = getattr(getattr(e, "response", None), "status_code", None)
    msg = str(e)[:500]
    msg = _KEY_RE.sub(r"\1…", msg)
    msg = _BARE_KEY_RE.sub("key=…", msg)
    # Service-curated messages are already user-safe; don't double-prefix them.
    if isinstance(e, RuntimeError) and msg.lower().startswith(
        ("shodan", "crt.sh", "subfinder")
    ):
        return msg[:500]
    if status is not None:
        return f"{source}: HTTP {status} — {msg}"[:500]
    if isinstance(e, (asyncio.TimeoutError, TimeoutError)):
        return f"{source}: timed out — retry with Re-scan"[:500]
    return f"{source}: {type(e).__name__}: {msg}"[:500]
