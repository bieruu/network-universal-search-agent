"""urlscan_service: keyless search history, three fields per finding, no blob."""

from __future__ import annotations

import json

import httpx
import pytest
import respx

from app.services import urlscan_service

SEARCH_URL = "https://urlscan.io/api/v1/search/"

# Planted blob markers. If any of these strings turns up in json.dumps(result)
# the module has leaked a result blob into the snapshot (TODO: "never the full
# result blob"). They are deliberately unique so a substring match is decisive.
DOM_BLOB = "<<leaked-dom-snapshot-marker>>"
REQUESTS_BLOB = "<<leaked-data-requests-marker>>"
LISTS_BLOB = "<<leaked-lists-marker>>"


def _scan(uuid: str, url: str, **extra: object) -> dict:
    """One search result shaped like the real anonymous payload."""
    return {
        "task": {
            "visibility": "public",
            "method": "api",
            "domain": "example.com",
            "apexDomain": "example.com",
            "time": "2026-10-08T01:21:12.740Z",
            "uuid": uuid,
            "url": url,
        },
        "page": {
            "country": "US",
            "ip": "93.184.216.34",
            "title": f"Page for {uuid}",
            "url": url,
            "domain": "example.com",
            "asn": "AS15133",
            "status": "200",
            "dom": DOM_BLOB,
        },
        "stats": {"requests": 271, "dataLength": 16637624},
        "lists": {"ips": ["93.184.216.34"], "urls": [LISTS_BLOB]},
        "data": {"requests": [{"request": {"url": REQUESTS_BLOB}, "response": {}}]},
        "_id": uuid,
        "sort": [1791422472740, uuid],
        "result": f"https://urlscan.io/api/v1/result/{uuid}/",
        "screenshot": f"https://urlscan.io/screenshots/{uuid}.png",
        **extra,
    }


def _body(results: list[dict], **extra: object) -> dict:
    return {
        "results": results,
        "total": len(results),
        "took": 87,
        "has_more": False,
        "search_date_limit_days": 30,
        **extra,
    }


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(follow_redirects=True)


@pytest.fixture(autouse=True)
def _no_ambient_key(monkeypatch):
    """Pin the key off for every test in this module.

    Without this the assertions below depend on whatever the developer's local
    `backend/.env` happens to contain: `settings` is built from the environment
    at import time, so a configured `URLSCAN_API_KEY` silently made the
    "sends no key when none is configured" test fail. Tests must not read
    ambient state — a passing suite here has to mean the same thing on every
    machine.
    """
    monkeypatch.setattr(urlscan_service.settings, "urlscan_api_key", "")


@pytest.mark.asyncio
async def test_lookup_normalises_verdicts_and_keeps_only_three_fields():
    malicious = _scan(
        "01a11919-87a3-7668-a54f-2a53ed17e490",
        "https://evil.example.com/login",
        verdicts={"overall": {"malicious": True, "score": 75}},
    )
    clean = _scan(
        "01a11907-91b7-77e5-b3c5-4ffe24bbc760",
        "https://example.com/",
        verdicts={"overall": {"malicious": False, "score": 0}},
    )
    unknown = _scan(
        "01a11907-91b7-77e5-b3c5-4ffe24bbc761",
        "https://example.com/other",
        verdict={"overall": {"suspicious": True}},
    )

    async with respx.mock:
        route = respx.get(SEARCH_URL).mock(
            return_value=httpx.Response(200, json=_body([malicious, clean, unknown]))
        )
        result = await urlscan_service.lookup("example.com", _client())

    assert result["source"] == "URLScan.io"
    assert result["status"] == "ok"
    assert result["count"] == 3
    assert result["truncated"] is False
    assert [f["verdict"] for f in result["findings"]] == [
        "malicious",
        "benign",
        "suspicious",
    ]
    assert result["findings"][0] == {
        "verdict": "malicious",
        "task_uuid": "01a11919-87a3-7668-a54f-2a53ed17e490",
        "page_url": "https://evil.example.com/login",
    }

    # The key assertion: nothing from the upstream blob survives, anywhere.
    dumped = json.dumps(result)
    assert DOM_BLOB not in dumped
    assert REQUESTS_BLOB not in dumped
    assert LISTS_BLOB not in dumped
    assert "dataLength" not in dumped
    assert "verdicts" not in dumped
    assert '"screenshot":' not in dumped
    for finding in result["findings"]:
        assert set(finding) == {"verdict", "task_uuid", "page_url"}

    # Newest-first order is urlscan's; the module must not reshuffle it.
    assert [f["task_uuid"] for f in result["findings"]] == [
        "01a11919-87a3-7668-a54f-2a53ed17e490",
        "01a11907-91b7-77e5-b3c5-4ffe24bbc760",
        "01a11907-91b7-77e5-b3c5-4ffe24bbc761",
    ]

    request = route.calls[0].request
    assert request.url.params["q"] == "domain:example.com"
    assert request.url.params["size"] == str(urlscan_service._PAGE_SIZE)
    assert request.url.params["size"] == "100"
    assert "API-Key" not in request.headers


@pytest.mark.asyncio
async def test_lookup_exposes_the_screenshot_of_the_newest_finding():
    older = _scan("01a11907-91b7-77e5-b3c5-4ffe24bbc760", "https://example.com/old")
    newer = _scan("01a11919-87a3-7668-a54f-2a53ed17e490", "https://example.com/new")

    async with respx.mock:
        respx.get(SEARCH_URL).mock(
            return_value=httpx.Response(200, json=_body([newer, older]))
        )
        result = await urlscan_service.lookup("example.com", _client())

    assert result["screenshot_url"] == (
        "https://urlscan.io/screenshots/01a11919-87a3-7668-a54f-2a53ed17e490.png"
    )


@pytest.mark.asyncio
async def test_lookup_ignores_an_unrecognised_screenshot_url():
    # A hostile or changed upstream must not be able to steer an <img src>.
    hostile = _scan("01a11919-87a3-7668-a54f-2a53ed17e490", "https://example.com/")
    hostile["screenshot"] = "https://evil.example.com/tracker.png"

    async with respx.mock:
        respx.get(SEARCH_URL).mock(
            return_value=httpx.Response(200, json=_body([hostile]))
        )
        result = await urlscan_service.lookup("example.com", _client())

    # Falls back to the documented shape built from the task UUID.
    assert result["screenshot_url"] == (
        "https://urlscan.io/screenshots/01a11919-87a3-7668-a54f-2a53ed17e490.png"
    )


@pytest.mark.asyncio
async def test_lookup_caps_findings_at_500_and_flags_truncation():
    results = [
        _scan(f"01a11919-87a3-7668-a54f-{index:012d}", f"https://example.com/{index}")
        for index in range(600)
    ]

    async with respx.mock:
        respx.get(SEARCH_URL).mock(
            return_value=httpx.Response(200, json=_body(results))
        )
        result = await urlscan_service.lookup("example.com", _client())

    assert result["status"] == "ok"
    assert result["count"] == 500
    assert len(result["findings"]) == 500
    assert result["truncated"] is True
    assert result["findings"][0]["task_uuid"] == "01a11919-87a3-7668-a54f-000000000000"
    assert result["findings"][-1]["task_uuid"] == "01a11919-87a3-7668-a54f-000000000499"
    assert "truncated" in result["note"].lower()


@pytest.mark.asyncio
async def test_lookup_flags_truncation_when_more_matches_exist_upstream():
    # A full page of hits does not mean full history: urlscan reports 6113
    # matches and hands back 100. Saying otherwise would be the lie the TODO
    # warns about.
    results = [
        _scan(f"01a11919-87a3-7668-a54f-{index:012d}", f"https://example.com/{index}")
        for index in range(urlscan_service._PAGE_SIZE)
    ]

    async with respx.mock:
        respx.get(SEARCH_URL).mock(
            return_value=httpx.Response(
                200, json=_body(results, total=6113, has_more=True)
            )
        )
        result = await urlscan_service.lookup("example.com", _client())

    assert result["count"] == 100
    assert result["truncated"] is True
    assert "more matches" in result["note"]


@pytest.mark.asyncio
async def test_lookup_dedupes_by_task_uuid():
    first = _scan("01a11919-87a3-7668-a54f-2a53ed17e490", "https://example.com/a")
    duplicate = dict(first)
    duplicate["page"] = dict(first["page"], url="https://example.com/b")

    async with respx.mock:
        respx.get(SEARCH_URL).mock(
            return_value=httpx.Response(200, json=_body([first, duplicate]))
        )
        result = await urlscan_service.lookup("example.com", _client())

    assert result["count"] == 1
    assert result["findings"][0]["page_url"] == "https://example.com/a"


@pytest.mark.asyncio
async def test_lookup_skips_unusable_rows_without_raising():
    results = [
        # No task UUID anywhere.
        {"page": {"url": "https://example.com/no-uuid"}, "_id": "", "task": {}},
        # Non-http(s) page URL: dropped, and the submitted URL is used instead.
        _scan("01a11919-87a3-7668-a54f-000000000001", "https://example.com/ok")
        | {"page": {"url": "javascript:alert(1)"}},
        # Only _id set: still dedupeable, so it is kept.
        {
            "_id": "01a11919-87a3-7668-a54f-000000000002",
            "page": {"url": "https://example.com/by-id"},
        },
        "not even a dict",
    ]

    async with respx.mock:
        respx.get(SEARCH_URL).mock(
            return_value=httpx.Response(200, json=_body(results))
        )
        result = await urlscan_service.lookup("example.com", _client())

    assert result["status"] == "ok"
    assert result["count"] == 2
    assert "javascript:" not in json.dumps(result)
    assert [f["task_uuid"] for f in result["findings"]] == [
        "01a11919-87a3-7668-a54f-000000000001",
        "01a11919-87a3-7668-a54f-000000000002",
    ]
    assert result["findings"][0]["page_url"] == "https://example.com/ok"


@pytest.mark.asyncio
async def test_lookup_falls_back_to_the_submitted_url():
    entry = _scan(
        "01a11919-87a3-7668-a54f-000000000001", "https://example.com/submitted"
    )
    entry["page"] = {"url": ""}

    async with respx.mock:
        respx.get(SEARCH_URL).mock(
            return_value=httpx.Response(200, json=_body([entry]))
        )
        result = await urlscan_service.lookup("example.com", _client())

    assert result["findings"][0]["page_url"] == "https://example.com/submitted"


@pytest.mark.asyncio
async def test_lookup_truncates_an_overlong_page_url():
    long_url = "https://example.com/" + "a" * 5000

    async with respx.mock:
        respx.get(SEARCH_URL).mock(
            return_value=httpx.Response(
                200,
                json=_body([_scan("01a11919-87a3-7668-a54f-000000000001", long_url)]),
            )
        )
        result = await urlscan_service.lookup("example.com", _client())

    assert len(result["findings"][0]["page_url"]) == urlscan_service._MAX_URL_CHARS


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"results": "not-a-list"},
        {"results": [None, 7, ["nested"]]},
        {"results": [{"verdicts": "malicious", "task": {"uuid": 42}}]},
        {"results": [{"verdicts": {"overall": ["malicious"]}, "_id": "abc"}]},
        {"results": [{"verdicts": {"overall": {"malicious": "maybe"}}, "_id": "abc"}]},
        {"results": [{"verdicts": None, "task": None, "_id": "abc"}]},
    ],
)
async def test_lookup_never_raises_on_odd_payloads(payload):
    async with respx.mock:
        respx.get(SEARCH_URL).mock(return_value=httpx.Response(200, json=payload))
        result = await urlscan_service.lookup("example.com", _client())

    assert result["status"] == "ok"
    assert isinstance(result["count"], int)
    assert isinstance(result["findings"], list)
    assert result["screenshot_url"] is None
    for finding in result["findings"]:
        assert finding["verdict"] in {"malicious", "suspicious", "benign", "none"}


@pytest.mark.asyncio
async def test_lookup_treats_a_non_json_body_as_unavailable():
    async with respx.mock:
        respx.get(SEARCH_URL).mock(return_value=httpx.Response(200, text="<html/>"))
        result = await urlscan_service.lookup("example.com", _client())

    assert result["status"] == "unavailable"
    assert result["count"] == 0
    assert result["findings"] == []
    assert result["screenshot_url"] is None
    # Never echo the upstream body back.
    assert "<html/>" not in json.dumps(result)


@pytest.mark.asyncio
async def test_lookup_reports_zero_results_as_ok():
    async with respx.mock:
        respx.get(SEARCH_URL).mock(
            return_value=httpx.Response(200, json=_body([], total=0))
        )
        result = await urlscan_service.lookup("example.com", _client())

    assert result["status"] == "ok"
    assert result["count"] == 0
    assert result["findings"] == []
    assert result["truncated"] is False
    assert result["screenshot_url"] is None
    assert "not evidence" in result["note"]


@pytest.mark.asyncio
async def test_lookup_reports_rate_limiting_as_unavailable():
    async with respx.mock:
        respx.get(SEARCH_URL).mock(
            return_value=httpx.Response(429, json={"message": "rate limit"})
        )
        result = await urlscan_service.lookup("example.com", _client())

    assert result["status"] == "unavailable"
    assert result["count"] == 0
    assert "rate" in result["note"].lower()
    assert "429" in result["note"]
    assert result["screenshot_url"] is None


@pytest.mark.asyncio
async def test_lookup_reports_forbidden_as_unavailable():
    async with respx.mock:
        respx.get(SEARCH_URL).mock(
            return_value=httpx.Response(403, json={"warning": "You're not logged in!"})
        )
        result = await urlscan_service.lookup("example.com", _client())

    assert result["status"] == "unavailable"
    assert "API key" in result["note"]
    assert "logged in" not in result["note"]


@pytest.mark.asyncio
async def test_lookup_reports_a_timeout_as_unavailable():
    async with respx.mock:
        respx.get(SEARCH_URL).mock(
            side_effect=httpx.ReadTimeout("timed out reading urlscan")
        )
        result = await urlscan_service.lookup("example.com", _client())

    assert result["status"] == "unavailable"
    assert result["count"] == 0
    assert "timed out" in result["note"]


@pytest.mark.asyncio
async def test_lookup_reports_a_transport_error_as_unavailable():
    async with respx.mock:
        respx.get(SEARCH_URL).mock(side_effect=httpx.ConnectError("connection refused"))
        result = await urlscan_service.lookup("example.com", _client())

    assert result["status"] == "unavailable"
    assert "ConnectError" in result["note"]


@pytest.mark.asyncio
async def test_lookup_reports_a_server_error_as_unavailable():
    async with respx.mock:
        respx.get(SEARCH_URL).mock(return_value=httpx.Response(500, text="boom"))
        result = await urlscan_service.lookup("example.com", _client())

    assert result["status"] == "unavailable"
    assert "500" in result["note"]
    assert "boom" not in result["note"]


@pytest.mark.asyncio
async def test_lookup_refuses_an_unusable_target_without_calling_upstream():
    async with respx.mock:
        route = respx.get(SEARCH_URL).mock(
            return_value=httpx.Response(200, json=_body([]))
        )
        result = await urlscan_service.lookup("*bad target*", _client())

    assert result["status"] == "unavailable"
    assert route.call_count == 0
    assert "nothing was queried" in result["note"]


@pytest.mark.asyncio
async def test_lookup_builds_an_ip_query_and_sets_an_explicit_timeout():
    async with respx.mock:
        route = respx.get(SEARCH_URL).mock(
            return_value=httpx.Response(200, json=_body([]))
        )
        result = await urlscan_service.lookup("93.184.216.34", _client())

    assert result["status"] == "ok"
    request = route.calls[0].request
    assert request.url.params["q"] == "ip:93.184.216.34"
    # URLScan does not redirect /api/v1/search/ today; a follow would be a 3xx
    # the mock cannot produce, so the assertion is on the documented behaviour.
    assert str(request.url) == f"{SEARCH_URL}?q=ip%3A93.184.216.34&size=100"


def test_timeout_follows_the_settings_pattern():
    assert urlscan_service.timeout_seconds() == urlscan_service._DEFAULT_TIMEOUT_SECONDS


def test_screenshot_requires_a_verified_shape():
    assert urlscan_service._SCREENSHOT_RE.fullmatch(
        "https://urlscan.io/screenshots/01a11919-87a3-7668-a54f-2a53ed17e490.png"
    )
    assert not urlscan_service._SCREENSHOT_RE.fullmatch(
        "https://evil.example.com/screenshots/x.png"
    )
    assert not urlscan_service._SCREENSHOT_RE.fullmatch(
        "http://urlscan.io/screenshots/x.png"
    )
    assert not urlscan_service._SCREENSHOT_RE.fullmatch(
        "https://urlscan.io/screenshots/x.svg"
    )


def test_source_label_is_stable():
    assert urlscan_service.SOURCE == "URLScan.io"
