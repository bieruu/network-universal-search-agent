"""URLScan.io public scan history via the keyless Search API.

Why search and not the Result API
---------------------------------
urlscan.io has two very different read endpoints. `/api/v1/result/{uuid}/`
answers `403 {"warning": "You're not logged in!"}` to an anonymous caller
(verified 2026-10-08), while `/api/v1/search/` answers `200` with results and
needs no API key at all. That makes search the only history source this module
can honestly offer without buying a plan, and it is why `status` is `"ok"`
rather than `"not_configured"`.

What "without a key" actually costs (verified 2026-10-08, anonymous requests)
-----------------------------------------------------------------------------
These are observations from live anonymous calls, not marketing copy:

  - **History depth is capped at 30 days.** Every response carries
    `search_date_limit_days: 30`, and a query pinned to older dates
    (`date:<now-35d`) returns `total: 0` while `date:>now-35d` returns
    everything. So this source can never be "full history" on the free tier and
    the note says so.
  - **At most 100 results per page.** `size=200` and `size=500` both come back
    as HTTP 200 with exactly 100 results — silently clamped, not rejected. The
    500-finding cap below is therefore defence against a changed page size, not
    a claim that one call can return 500.
  - **30 requests per minute per IP**, `X-Rate-Limit-Action: search`,
    `X-Rate-Limit-Scope: ip-address`. The anonymous quota is the reason a 429 is
    reported as `unavailable` with a rate-limit note instead of being retried.
  - **Verdicts are effectively absent.** `verdicts.*` is a searchable field only
    on Professional/Enterprise/Ultimate, and anonymous search responses
    carried no verdict object at all. Normalisation still runs so a keyed
    deployment reports real verdicts, but `"none"` is the honest expected value
    here — it means "urlscan published no verdict in this response", never
    "the page is safe".

Still UNVERIFIED, and deliberately not claimed anywhere in this module:

  - Whether the 30-day window or the 100-result page size differ for an
    authenticated free account or a paid plan. Pricing
    (https://urlscan.io/pricing/, free plan) lists quotas per *account* and
    shows Advanced Search as a paid feature, but it publishes no search
    retention number, so nothing here can be read as "history depth is 30 days
    on every tier".
  - The exact shape of `verdict.overall`. The Result API changelog documents
    `verdicts.overall.brands`; the search reference documents
    `verdicts.malicious` / `verdicts.score`. A `suspicious` boolean on that
    object is accepted defensively but no primary doc lists one. `_verdict()`
    therefore reads several shapes and treats anything it cannot read as
    `"none"`.

Screenshot
----------
Each search result carries `screenshot`, which the live API returns as
`https://urlscan.io/screenshots/{uuid}.png` and the API introduction documents
as `https://urlscan.io/screenshots/$uuid.png`. `screenshot_url` is the newest
kept finding's screenshot, exposed passively so the live-screenshot feature can
use it without submitting anything (submission is a separate, keyed, paid call).
It is `None` whenever there is no usable task UUID to build it from.

What is deliberately NOT kept
-----------------------------
urlscan's real payload is enormous — `data.requests` (every HTTP transaction),
`data.dom`, `lists`, `page`, `meta`, `stats`. Only three fields per finding
survive: normalised verdict, task UUID, page URL. The full result blob is never
read out of the response, so it cannot reach `scans.result_snapshot`.
"""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import urlsplit

import httpx

from app.core.config import settings
from app.core.errors import sanitize_error

SOURCE = "URLScan.io"

_SEARCH_URL = "https://urlscan.io/api/v1/search/"
_SCREENSHOT_PREFIX = "https://urlscan.io/screenshots/"

# Anonymous search is clamped to 100 results per page (verified), which is also
# the documented default. Asking for more would only cost quota.
_PAGE_SIZE = 100
_MAX_FINDINGS = 500
_MAX_UUID_CHARS = 64
_MAX_URL_CHARS = 2048
_MAX_NOTE_CHARS = 400

# `app/core/config.py` has no `scan_timeout_urlscan` field yet; read it when the
# integration adds one so operators can tune it like the other API sources.
_DEFAULT_TIMEOUT_SECONDS = 12.0

_IP_CHARS = frozenset("0123456789.:abcdefABCDEF[]%")
_HOST_RE = re.compile(r"^[a-z0-9._-]+$")
_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE
)
# The Search API is ElasticSearch query-string syntax, whose reserved
# characters must be backslash-escaped per the API reference.
_RESERVED_RE = re.compile(r'([\\+\-=&|><!(){}\[\]^"~*?:/])')
_SCREENSHOT_RE = re.compile(
    r"^https://urlscan\.io/screenshots/[0-9a-zA-Z-]{1,64}\.png$", re.IGNORECASE
)


def timeout_seconds() -> float:
    """Per-request timeout, following the `scan_timeout_*` settings pattern."""
    raw = getattr(settings, "scan_timeout_urlscan", _DEFAULT_TIMEOUT_SECONDS)
    try:
        return float(raw)
    except (TypeError, ValueError):
        return _DEFAULT_TIMEOUT_SECONDS


def _api_key() -> str:
    """Configured API key, or `""`. Optional: search works without one.

    Read through `getattr` because `Settings` has no `urlscan_api_key` field
    yet; the module runs keyless until the integration adds one.
    """
    return str(getattr(settings, "urlscan_api_key", "") or "").strip()


def _query_for(target: str) -> str | None:
    """Build the ElasticSearch `q` for a target, or `None` if it is unusable.

    Domains search as `domain:` (the field also matches every subdomain, per
    the API reference) and IPs as `ip:`. Anything that cannot be either is
    refused rather than sent upstream, because a malformed query is both a
    wasted quota unit and a chance to smuggle syntax into `q`.
    """
    candidate = (target or "").strip().lower()
    if "//" in candidate:
        candidate = urlsplit(candidate).hostname or ""
    candidate = candidate.split("/")[0].split("?")[0].split("#")[0]
    candidate = candidate.removeprefix("*.").rstrip(".")
    if candidate.startswith("[") and candidate.endswith("]"):
        candidate = candidate[1:-1]
    if not candidate or not _HOST_RE.fullmatch(candidate):
        return None
    field = "ip" if set(candidate) <= _IP_CHARS else "domain"
    # Hoisted out of the f-string on purpose: a backslash inside an f-string
    # expression is a SyntaxError before Python 3.12 (PEP 701), and both the
    # container image and CI run 3.11 — this module would not import at all.
    escaped = _RESERVED_RE.sub(r"\\\1", candidate)
    return f"{field}:{escaped}"


def _flag(value: Any) -> bool | None:
    """A real boolean verdict flag, or `None` when the value says nothing.

    Anything that is not a boolean (a score, a string enum, a nested object) is
    treated as *unknown* rather than coerced, so an upstream shape change
    degrades to `"none"` instead of inventing a verdict.
    """
    if isinstance(value, bool):
        return value
    if isinstance(value, str) and value.strip().lower() in {"true", "false"}:
        return value.strip().lower() == "true"
    return None


def _verdict(result: dict[str, Any]) -> str:
    """Map urlscan's verdict object onto one of four honest buckets.

    Tried in order of specificity; the first candidate that actually carries a
    boolean flag decides. `malicious` wins over `suspicious`, and an explicit
    `false` is reported as `"benign"` — urlscan did scan the page and did not
    call it malicious. No readable candidate at all is `"none"`, which means
    "no verdict published", never "safe".
    """
    nodes: list[Any] = []
    for key in ("verdicts", "verdict"):
        node = result.get(key)
        if isinstance(node, dict):
            overall = node.get("overall")
            if isinstance(overall, dict):
                nodes.append(overall)
            nodes.append(node)
    urlscan_node = result.get("verdicts")
    if isinstance(urlscan_node, dict) and isinstance(urlscan_node.get("urlscan"), dict):
        nodes.append(urlscan_node["urlscan"])

    for node in nodes:
        malicious = _flag(node.get("malicious"))
        if malicious is True:
            return "malicious"
        suspicious = _flag(node.get("suspicious"))
        if suspicious is True:
            return "suspicious"
        if malicious is False:
            return "benign"
    return "none"


def _task_uuid(result: dict[str, Any]) -> str:
    """`task.uuid` (or `_id`) when it is usable as a lookup key, else `""`.

    `_id` is the same UUID and is read only as a fallback: the API
    introduction says both describe the scan, and a result missing `task`
    entirely should still be dedupeable rather than duplicated.
    """
    task = result.get("task")
    for value in (
        task.get("uuid") if isinstance(task, dict) else None,
        result.get("_id"),
    ):
        if isinstance(value, str):
            candidate = value.strip()
            if candidate and len(candidate) <= _MAX_UUID_CHARS:
                return candidate
    return ""


def _page_url(result: dict[str, Any]) -> str:
    """The effective page URL, or `""` when it is not an http(s) URL.

    `page.url` is the primary request after redirects and `task.url` the
    submitted one; the second is only a fallback. A non-http(s) scheme is
    dropped rather than shown: it cannot be a page, and it is exactly the kind
    of string a hostile submission would use to get something rendered.
    """
    task = result.get("task")
    for value in (
        (
            result.get("page", {}).get("url")
            if isinstance(result.get("page"), dict)
            else None
        ),
        task.get("url") if isinstance(task, dict) else None,
    ):
        if not isinstance(value, str):
            continue
        candidate = value.strip()
        if not candidate:
            continue
        scheme = urlsplit(candidate).scheme.lower()
        if scheme in {"http", "https"}:
            return candidate[:_MAX_URL_CHARS]
    return ""


def _screenshot_url(result: dict[str, Any], task_uuid: str) -> str | None:
    """The verified screenshot URL for a finding, or `None`.

    Prefers urlscan's own `screenshot` value when it matches the documented
    `https://urlscan.io/screenshots/{uuid}.png` shape — an unrecognised host or
    path is refused, since this string ends up in an `<img src>` in the UI.
    Otherwise the documented shape is built from the task UUID, which is safe
    because a UUID cannot steer the URL anywhere.
    """
    value = result.get("screenshot")
    if isinstance(value, str) and _SCREENSHOT_RE.fullmatch(value.strip()):
        return value.strip()
    if _UUID_RE.fullmatch(task_uuid):
        return f"{_SCREENSHOT_PREFIX}{task_uuid}.png"
    return None


def _result(
    status: str,
    note: str,
    findings: list[dict[str, Any]] | None = None,
    *,
    truncated: bool = False,
    screenshot_url: str | None = None,
    total: int | None = None,
    window_days: int | None = None,
) -> dict[str, Any]:
    rows = findings or []
    text = note
    if truncated:
        text = f"{text} List truncated."
    return {
        "source": SOURCE,
        "status": status,
        "count": len(rows),
        "total": total,
        "findings": rows,
        "truncated": truncated,
        "screenshot_url": screenshot_url,
        "note": text[:_MAX_NOTE_CHARS],
        "window_days": window_days,
    }


def _unavailable(note: str) -> dict[str, Any]:
    """The fail-closed shape: nothing retrieved, and the reason stated."""
    return _result("unavailable", note)


async def lookup(
    target: str, client: httpx.AsyncClient | None = None
) -> dict[str, Any]:
    """Public urlscan.io scan history for `target`. Never raises.

    Read-only by construction: one GET against the keyless Search API, no
    submission, no retry. Every failure path returns `status: "unavailable"`
    with a sanitised note (AGENTS.md §5: never 500 on source failure).
    """
    query = _query_for(target)
    if query is None:
        return _unavailable(
            "URLScan.io: target is not a searchable hostname or IP; nothing was "
            "queried upstream."
        )

    headers = {"User-Agent": "osint-dashboard/1.0"}
    key = _api_key()
    if key:
        # Documented header name is `API-Key` (not `x-api-key`). Only ever
        # outbound, never logged and never echoed into a note.
        headers["API-Key"] = key

    own = client is None
    if own:
        # urlscan.io 301/302s between hostnames; the API introduction asks
        # integrations to follow them.
        client = httpx.AsyncClient(
            headers=headers, follow_redirects=True, timeout=timeout_seconds()
        )
    try:
        response = await client.get(
            _SEARCH_URL,
            params={"q": query, "size": str(_PAGE_SIZE)},
            headers=headers,
            timeout=timeout_seconds(),
        )
    except httpx.HTTPError as e:
        # Covers httpx.TimeoutException; sanitize_error gives it its own wording.
        return _unavailable(sanitize_error(SOURCE, e))
    finally:
        if own and client is not None:
            await client.aclose()

    if response.status_code == 429:
        return _unavailable(
            "URLScan.io rate-limited this request (HTTP 429); anonymous search "
            "allows about 30 requests per minute per IP. No history retrieved."
        )
    if response.status_code == 403:
        return _unavailable(
            "URLScan.io refused the request (HTTP 403). Its Result API requires "
            "a signed-in API key and search access can change without notice. "
            "No history retrieved."
        )
    if response.status_code >= 400:
        return _unavailable(sanitize_error(SOURCE, _http_error(response)))

    try:
        body = response.json()
    except ValueError as e:
        return _unavailable(sanitize_error(SOURCE, e))
    if not isinstance(body, dict):
        return _unavailable("URLScan.io returned an unexpected response shape.")

    raw_results = body.get("results")
    if not isinstance(raw_results, list):
        raw_results = []

    findings: list[dict[str, Any]] = []
    seen: set[str] = set()
    screenshot_url: str | None = None
    for entry in raw_results:
        if len(findings) >= _MAX_FINDINGS:
            break
        if not isinstance(entry, dict):
            continue
        task_uuid = _task_uuid(entry)
        if not task_uuid or task_uuid in seen:
            continue
        page_url = _page_url(entry)
        if not page_url:
            continue
        seen.add(task_uuid)
        if screenshot_url is None:
            # API order is newest-first, so the first kept finding is the
            # newest one — the screenshot worth showing.
            screenshot_url = _screenshot_url(entry, task_uuid)
        findings.append(
            {
                "verdict": _verdict(entry),
                "task_uuid": task_uuid,
                "page_url": page_url,
            }
        )

    total = body.get("total")
    total = total if isinstance(total, int) and not isinstance(total, bool) else None
    window_days = body.get("search_date_limit_days")
    window_days = (
        window_days
        if isinstance(window_days, int) and not isinstance(window_days, bool)
        else None
    )
    has_more = body.get("has_more") is True
    truncated = (
        has_more
        or (total is not None and total > len(raw_results))
        or (len(raw_results) > _MAX_FINDINGS)
    )

    if not findings:
        note = (
            f"No public urlscan.io scans matched this target in the {window_days}-day "
            "window urlscan serves anonymously. That is not evidence the target is "
            "clean: urlscan only scans what someone submitted or its automatic "
            "sources found."
            if window_days
            else "No public urlscan.io scans matched this target. That is not "
            "evidence the target is clean."
        )
        return _result(
            "ok",
            note,
            [],
            total=total,
            window_days=window_days,
            truncated=has_more or (total is not None and total > 0),
        )

    note = (
        "Recent public urlscan.io scans, newest first: the anonymous search window "
        f"is {window_days} days, at most {_PAGE_SIZE} results per request, so this "
        "is not full history. Verdict is 'none' unless urlscan published one; "
        "absence of a verdict is not evidence a page is benign."
    )
    if truncated:
        note += (
            " urlscan reports more matches than were fetched; older entries need "
            "the paged search_after API."
        )
    return _result(
        "ok",
        note,
        findings,
        truncated=truncated,
        screenshot_url=screenshot_url,
        total=total,
        window_days=window_days,
    )


def _http_error(response: httpx.Response) -> httpx.HTTPStatusError:
    """Turn a non-2xx response into the error `sanitize_error` expects.

    Built rather than raised so the upstream body never reaches the note; the
    status code and reason are the only facts worth keeping.
    """
    try:
        request = response.request
    except RuntimeError:
        request = None
    if request is None:
        request = httpx.Request("GET", _SEARCH_URL)
    return httpx.HTTPStatusError(
        f"HTTP {response.status_code}", request=request, response=response
    )
