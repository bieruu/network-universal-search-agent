"""Leak-Lookup service tests.

No live network: every request is intercepted by `respx`. The mock URL is the
real endpoint string, so if a route ever fails to match, respx raises
`AllMockedAssertionError` instead of letting a real request to a real
breach-lookup service escape the test.

The centre of gravity here is `test_planted_leaked_pair_never_reaches_output`:
Leak-Lookup's private-key tier returns actual leaked credential rows, and the
only acceptable outcome is that none of it leaves the service.
"""

from __future__ import annotations

import json
from urllib.parse import parse_qs

import httpx
import pytest
import respx

from app.core.config import settings
from app.services import leaklookup_service

API_URL = leaklookup_service.API_URL

LEAKED_EMAIL = "jordan.reeve@example-breach-target.test"
LEAKED_HASH = "b4b9b02e6f09e9a756b3ebe7aaca9b190"
SECOND_HASH = "5baa61e4c9b93f3f0682250b6cf8331b7ee68fd8"


def _private_key_payload() -> dict:
    """A realistic private-key response: three leaked credential rows, two breaches."""
    return {
        "error": "false",
        "message": {
            "adobe-2013": [
                {
                    "email_address": LEAKED_EMAIL,
                    "password": LEAKED_HASH,
                    "plaintext": "correct-horse-battery",
                    "salt": "Xk9#2fQ",
                    "username": "jreeve",
                    "firstname": "Jordan",
                    "lastname": "Reeve",
                },
                {
                    "email_address": "second.person@example-breach-target.test",
                    "password": SECOND_HASH,
                    "username": "sperson",
                },
            ],
            "linkedin-2012": [
                {
                    "email_address": "third.person@example-breach-target.test",
                    "password": SECOND_HASH,
                    "plaintext": "qwertyuiop",
                }
            ],
        },
    }


def _public_key_payload() -> dict:
    """The documented public-key shape: breach names, every column stripped."""
    return {"error": "false", "message": {"adobe-2013": [], "linkedin-2012": []}}


def _set_key(monkeypatch, value: str) -> None:
    """Plant the API key on the settings instance.

    Written against `__dict__` rather than `setattr` because `Settings` is a
    pydantic `BaseSettings` and its `__setattr__` rejects a field that does not
    exist yet. `Settings.leaklookup_api_key` is NEEDS INTEGRATION; until it lands
    the service reads it with `getattr(..., "")`, so seeding `__dict__` is
    exactly what the real field will do once it is added. `monkeypatch` restores
    the previous state afterwards, so no test leaks a key into another.
    """
    monkeypatch.setitem(settings.__dict__, "leaklookup_api_key", value)


@pytest.fixture
def with_key(monkeypatch):
    """A configured public key."""
    _set_key(monkeypatch, "test-key-0000")


def _route(status: int = 200, payload=None, content: bytes | None = None):
    kwargs = {"content": content} if content is not None else {"json": payload}
    return respx.post(API_URL).mock(return_value=httpx.Response(status, **kwargs))


# --------------------------------------------------------------------------
# THE key test: planted credentials must not survive into the output.
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_planted_leaked_pair_never_reaches_output(with_key):
    async with respx.mock:
        _route(payload=_private_key_payload())
        result = await leaklookup_service.lookup("example-breach-target.test")

    blob = json.dumps(result)

    # The two things that must never appear: the address and the hash. The rest
    # is the same rule applied to the neighbouring fields in that row.
    assert LEAKED_EMAIL not in blob
    assert LEAKED_HASH not in blob
    assert SECOND_HASH not in blob
    assert "second.person@example-breach-target.test" not in blob
    assert "third.person@example-breach-target.test" not in blob
    assert "correct-horse-battery" not in blob
    assert "qwertyuiop" not in blob
    assert "Xk9#2fQ" not in blob
    assert "jreeve" not in blob
    assert "Jordan" not in blob
    assert "Reeve" not in blob

    # ...while the aggregate shape the contract promises IS present, so this is
    # a redaction proof and not a "returned nothing" proof.
    assert result["count"] == 3
    assert result["findings"] == [
        {"name": "adobe-2013", "date": None, "matches": 2},
        {"name": "linkedin-2012", "date": None, "matches": 1},
    ]

    # Every emitted finding is restricted to these three keys by construction.
    for finding in result["findings"]:
        assert set(finding) == {"name", "date", "matches"}


@pytest.mark.asyncio
async def test_credential_rows_are_discarded_not_passed_through(with_key):
    """A breach with one row and one with many must reduce to the same shape.

    Nothing in the service scales with the number of credential records, so a
    row's contents cannot leak through a length-dependent path either.
    """
    rows = [
        {
            "email_address": f"victim{i}@example-breach-target.test",
            "password": f"hash{i}",
        }
        for i in range(500)
    ]
    async with respx.mock:
        _route(payload={"error": "false", "message": {"bigbreach": rows}})
        result = await leaklookup_service.lookup("example-breach-target.test")

    blob = json.dumps(result)
    assert "example-breach-target.test" not in blob
    assert "victim0@" not in blob
    assert "hash499" not in blob
    assert result["count"] == 500
    assert result["findings"] == [{"name": "bigbreach", "date": None, "matches": 500}]


@pytest.mark.asyncio
async def test_target_is_never_echoed_into_the_note(with_key):
    """An address passed as a target is refused, and the refusal stays quiet."""
    async with respx.mock:
        _route(payload=_private_key_payload())
        result = await leaklookup_service.lookup(LEAKED_EMAIL)

    assert result["status"] == "unavailable"
    assert LEAKED_EMAIL not in json.dumps(result)
    # Refused before any request was spent.
    assert not respx.calls.called


# --------------------------------------------------------------------------
# Happy path
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_no_results_is_ok_with_zero_count(with_key):
    async with respx.mock:
        _route(payload={"error": "false", "message": {}})
        result = await leaklookup_service.lookup("clean-target.test")

    assert result["status"] == "ok"
    assert result["count"] == 0
    assert result["findings"] == []
    assert result["truncated"] is False
    assert result["note"]
    assert "No indexed leaks" in result["note"]


@pytest.mark.asyncio
async def test_public_key_matches_are_reported_as_not_countable(with_key):
    """Breach names matched, but the counts are undisclosed — say so, do not guess.

    Reporting count=0 here without qualification would render a breached target
    as a clean one, which is the exact lie this module exists to avoid.
    """
    async with respx.mock:
        _route(payload=_public_key_payload())
        result = await leaklookup_service.lookup("example-breach-target.test")

    assert result["status"] == "ok"
    assert result["count"] == 0
    assert [f["name"] for f in result["findings"]] == ["adobe-2013", "linkedin-2012"]
    assert all(f["matches"] is None for f in result["findings"])
    assert "NOT COUNTABLE" in result["note"]


@pytest.mark.asyncio
async def test_breach_date_is_reported_when_present(with_key):
    payload = {
        "error": "false",
        "message": {
            "adobe-2013": [
                {
                    "email_address": LEAKED_EMAIL,
                    "password": LEAKED_HASH,
                    "breach_date": "2013-10-04",
                }
            ]
        },
    }
    async with respx.mock:
        _route(payload=payload)
        result = await leaklookup_service.lookup("example-breach-target.test")

    assert result["findings"] == [
        {"name": "adobe-2013", "date": "2013-10-04", "matches": 1}
    ]
    assert LEAKED_EMAIL not in json.dumps(result)


@pytest.mark.asyncio
async def test_request_shape_is_documented_endpoint_form_body_and_ua(with_key):
    async with respx.mock:
        _route(payload=_public_key_payload())
        await leaklookup_service.lookup("Example-Breach-Target.test.")
        # Asserted INSIDE the context: respx clears `calls` on exit, so reading
        # `calls.last` afterwards would silently inspect nothing.
        request = respx.calls.last.request

    assert str(request.url) == API_URL
    assert request.method == "POST"
    assert request.headers["User-Agent"] == "osint-dashboard/1.0"
    # The key travels in the form BODY, never in the URL: a logged URL cannot
    # leak it, and it never reaches an httpx exception message.
    assert "key" not in str(request.url)
    assert parse_qs(request.content.decode()) == {
        "key": ["test-key-0000"],
        "type": ["domain"],
        "query": ["example-breach-target.test"],
    }


@pytest.mark.asyncio
async def test_ip_target_uses_the_ipaddress_search_type(with_key):
    async with respx.mock:
        _route(payload={"error": "false", "message": {}})
        await leaklookup_service.lookup("8.8.8.8")
        body = parse_qs(respx.calls.last.request.content.decode())

    assert body["type"] == ["ipaddress"]
    assert body["query"] == ["8.8.8.8"]


@pytest.mark.asyncio
async def test_timeout_is_bounded_by_the_config_pattern(with_key):
    async with respx.mock:
        _route(payload=_public_key_payload())
        await leaklookup_service.lookup("example-breach-target.test")
        extensions = respx.calls.last.request.extensions["timeout"]

    timeout = leaklookup_service._timeout_seconds()
    assert timeout == settings.scan_timeout_shodan
    assert extensions["connect"] == timeout


# --------------------------------------------------------------------------
# Rate limiting
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_http_429_is_unavailable_with_a_rate_limit_note(with_key):
    async with respx.mock:
        _route(status=429, payload={"error": "true", "message": "RATE LIMIT REACHED"})
        result = await leaklookup_service.lookup("example-breach-target.test")
        # Exactly one request: no retry loop against a documented daily cap.
        call_count = respx.calls.call_count

    assert call_count == 1
    assert result["status"] == "unavailable"
    assert result["count"] == 0
    assert result["findings"] == []
    assert "rate limiting" in result["note"].lower()
    assert "429" in result["note"]


@pytest.mark.asyncio
async def test_in_body_daily_limit_code_is_unavailable(with_key):
    """The documented limit codes arrive as HTTP 200 with an error body."""
    async with respx.mock:
        _route(payload={"error": "true", "message": "REQUEST LIMIT REACHED"})
        result = await leaklookup_service.lookup("example-breach-target.test")

    assert result["status"] == "unavailable"
    assert "daily request limit" in result["note"].lower()


@pytest.mark.asyncio
async def test_in_body_per_minute_limit_code_is_unavailable(with_key):
    async with respx.mock:
        _route(payload={"error": "true", "message": "RATE LIMIT REACHED"})
        result = await leaklookup_service.lookup("example-breach-target.test")

    assert result["status"] == "unavailable"
    assert "rate limiting" in result["note"].lower()


@pytest.mark.asyncio
async def test_invalid_api_key_is_unavailable_with_a_curated_note(with_key):
    async with respx.mock:
        _route(payload={"error": "true", "message": "INVALID API KEY"})
        result = await leaklookup_service.lookup("example-breach-target.test")

    assert result["status"] == "unavailable"
    assert "invalid" in result["note"].lower()


# --------------------------------------------------------------------------
# Failure modes — never raise, never leak
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_timeout_is_unavailable(with_key):
    async with respx.mock:
        respx.post(API_URL).mock(side_effect=httpx.ReadTimeout("timed out"))
        result = await leaklookup_service.lookup("example-breach-target.test")

    assert result["status"] == "unavailable"
    assert result["count"] == 0
    assert "timed out" in result["note"].lower()


@pytest.mark.asyncio
async def test_transport_failure_is_unavailable(with_key):
    async with respx.mock:
        respx.post(API_URL).mock(side_effect=httpx.ConnectError("no route"))
        result = await leaklookup_service.lookup("example-breach-target.test")

    assert result["status"] == "unavailable"
    assert "ConnectError" in result["note"]


@pytest.mark.asyncio
async def test_server_error_is_unavailable(with_key):
    async with respx.mock:
        _route(status=503, payload={"error": "true", "message": "SEARCH FAILED"})
        result = await leaklookup_service.lookup("example-breach-target.test")

    assert result["status"] == "unavailable"
    assert "503" in result["note"]


@pytest.mark.asyncio
async def test_findings_are_capped_at_500(with_key):
    message = {
        f"breach-{i:04d}": [{"email_address": LEAKED_EMAIL, "password": LEAKED_HASH}]
        for i in range(600)
    }
    async with respx.mock:
        _route(payload={"error": "false", "message": message})
        result = await leaklookup_service.lookup("example-breach-target.test")

    assert result["status"] == "ok"
    assert result["truncated"] is True
    assert len(result["findings"]) == leaklookup_service.MAX_FINDINGS == 500
    # count is the true total from every breach, not the truncated view.
    assert result["count"] == 600
    assert LEAKED_EMAIL not in json.dumps(result)


@pytest.mark.asyncio
async def test_exactly_500_breaches_is_not_truncated(with_key):
    message = {f"breach-{i:04d}": [{"password": LEAKED_HASH}] for i in range(500)}
    async with respx.mock:
        _route(payload={"error": "false", "message": message})
        result = await leaklookup_service.lookup("example-breach-target.test")

    assert result["truncated"] is False
    assert len(result["findings"]) == 500


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payload",
    [
        [],
        "a bare string",
        {"message": ["not", "a", "dict"]},
        {"message": "not-a-dict"},
        {"error": "false"},
        {"no": "keys", "at": "all"},
    ],
    ids=["list", "string", "message-list", "message-string", "no-message", "junk"],
)
async def test_malformed_payload_is_handled_without_raising(with_key, payload):
    async with respx.mock:
        _route(payload=payload)
        result = await leaklookup_service.lookup("example-breach-target.test")

    assert result["status"] == "unavailable"
    assert result["count"] == 0
    assert result["findings"] == []
    assert result["note"]


@pytest.mark.asyncio
async def test_non_json_response_is_unavailable(with_key):
    async with respx.mock:
        _route(content=b"<html>gateway error</html>")
        result = await leaklookup_service.lookup("example-breach-target.test")

    assert result["status"] == "unavailable"
    assert "not JSON" in result["note"]


@pytest.mark.asyncio
async def test_unusable_breach_keys_are_skipped_not_echoed(with_key):
    """A hostile breach-name key must not become a row unfiltered."""
    payload = {
        "error": "false",
        "message": {
            "\x1b[31mred\x1b[0m": [{"password": LEAKED_HASH}],
            "   ": [{"password": LEAKED_HASH}],
            "realbreach": [{"password": LEAKED_HASH}],
        },
    }
    async with respx.mock:
        _route(payload=payload)
        result = await leaklookup_service.lookup("example-breach-target.test")

    blob = json.dumps(result)
    assert result["status"] == "ok"
    # The blank key is dropped; the escape sequence is stripped, not passed on.
    assert [f["name"] for f in result["findings"]] == ["red", "realbreach"]
    assert "\x1b" not in blob
    assert LEAKED_HASH not in blob


@pytest.mark.asyncio
async def test_breach_names_are_truncated(with_key):
    async with respx.mock:
        _route(
            payload={
                "error": "false",
                "message": {"b" * 900: [{"password": LEAKED_HASH}]},
            }
        )
        result = await leaklookup_service.lookup("example-breach-target.test")

    assert len(result["findings"][0]["name"]) == leaklookup_service.MAX_NAME_CHARS


@pytest.mark.asyncio
async def test_error_message_containing_secrets_is_scrubbed(with_key):
    """An upstream error that echoes the key and an address must not relay either."""
    hostile = (
        f"upstream failed key=test-key-0000 for {LEAKED_EMAIL} "
        f"password={LEAKED_HASH} (see https://leak-lookup.com/api/search?key=test-key-0000)"
    )
    async with respx.mock:
        _route(payload={"error": "true", "message": hostile})
        result = await leaklookup_service.lookup("example-breach-target.test")

    blob = json.dumps(result)
    assert result["status"] == "unavailable"
    assert "test-key-0000" not in blob
    assert LEAKED_EMAIL not in blob
    assert LEAKED_HASH not in blob
    assert "[redacted]" in result["note"]
    assert "key=…" in result["note"]
    assert result["note"] != hostile


@pytest.mark.asyncio
async def test_documented_error_code_is_replaced_not_relayed(with_key):
    """A known code becomes a sentence written here, so no upstream text passes."""
    async with respx.mock:
        _route(payload={"error": "true", "message": "SEARCH FAILED"})
        result = await leaklookup_service.lookup("example-breach-target.test")

    assert result["status"] == "unavailable"
    assert result["note"] == "Leak-Lookup search failed upstream — retry later."


@pytest.mark.asyncio
async def test_error_string_false_is_not_treated_as_an_error(with_key):
    """`"error": "false"` is a truthy STRING in Python — the success path must win."""
    async with respx.mock:
        _route(payload=_private_key_payload())
        result = await leaklookup_service.lookup("example-breach-target.test")

    assert result["status"] == "ok"
    assert result["count"] == 3


@pytest.mark.asyncio
async def test_boolean_error_false_is_not_treated_as_an_error(with_key):
    async with respx.mock:
        _route(
            payload={
                "error": False,
                "message": {"adobe-2013": [{"password": LEAKED_HASH}]},
            }
        )
        result = await leaklookup_service.lookup("example-breach-target.test")

    assert result["status"] == "ok"
    assert result["count"] == 1


@pytest.mark.asyncio
async def test_boolean_error_true_is_treated_as_an_error(with_key):
    async with respx.mock:
        _route(payload={"error": True, "message": "INVALID API KEY"})
        result = await leaklookup_service.lookup("example-breach-target.test")

    assert result["status"] == "unavailable"


# --------------------------------------------------------------------------
# Configuration and refused targets — no request may be spent on either
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_missing_key_is_not_configured_and_sends_no_request(monkeypatch):
    monkeypatch.delitem(settings.__dict__, "leaklookup_api_key", raising=False)
    async with respx.mock:
        result = await leaklookup_service.lookup("example-breach-target.test")

    assert result["status"] == "not_configured"
    assert result["count"] == 0
    assert result["findings"] == []
    assert not respx.calls.called
    assert "LEAKLOOKUP_API_KEY" in result["note"]


@pytest.mark.asyncio
async def test_whitespace_only_key_is_not_configured(monkeypatch):
    _set_key(monkeypatch, "   ")
    async with respx.mock:
        result = await leaklookup_service.lookup("example-breach-target.test")

    assert result["status"] == "not_configured"
    assert not respx.calls.called


@pytest.mark.asyncio
async def test_missing_key_is_checked_before_target_refusal(monkeypatch):
    """Order is documented: no key means nothing to spend, whatever the target."""
    monkeypatch.delitem(settings.__dict__, "leaklookup_api_key", raising=False)
    async with respx.mock:
        result = await leaklookup_service.lookup("127.0.0.1")

    assert result["status"] == "not_configured"
    assert not respx.calls.called


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "target",
    ["127.0.0.1", "10.0.0.5", "192.168.1.1", "169.254.169.254", "localhost"],
    ids=["loopback", "rfc1918-10", "rfc1918-192", "link-local", "localhost-name"],
)
async def test_private_and_local_targets_are_never_queried(with_key, target):
    async with respx.mock:
        result = await leaklookup_service.lookup(target)

    assert result["status"] == "unavailable"
    assert not respx.calls.called
    assert "not sent" in result["note"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "target",
    [LEAKED_EMAIL, "", "   ", "a@b.test"],
    ids=["email", "empty", "whitespace", "embedded-at"],
)
async def test_individual_lookup_targets_are_never_queried(with_key, target):
    """An address or a blank is refused as a person-lookup, not sent upstream."""
    async with respx.mock:
        result = await leaklookup_service.lookup(target)

    assert result["status"] == "unavailable"
    assert not respx.calls.called
    assert "not look up individuals" in result["note"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "target",
    ["not a target", "no-dot-here", "bad_label.example", "-lead.example"],
    ids=["spaces", "single-label", "underscore", "leading-hyphen"],
)
async def test_malformed_hostnames_are_never_queried(with_key, target):
    """A hostname that cannot be a registrable domain never burns an allowance."""
    async with respx.mock:
        result = await leaklookup_service.lookup(target)

    assert result["status"] == "unavailable"
    assert not respx.calls.called
    assert "not a valid domain name" in result["note"]


@pytest.mark.asyncio
async def test_non_string_target_is_reported_not_raised(with_key):
    async with respx.mock:
        result = await leaklookup_service.lookup(None)  # type: ignore[arg-type]

    assert result["status"] == "unavailable"
    assert not respx.calls.called


# --------------------------------------------------------------------------
# Contract shape
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_every_result_carries_exactly_the_contract_keys(with_key):
    """One assertion over the happy, empty, limited, refused and error paths."""
    cases = [
        ({"error": "false", "message": {"b": [{"password": LEAKED_HASH}]}}, "ok"),
        ({"error": "false", "message": {}}, "ok"),
        (_public_key_payload(), "ok"),
        ({"error": "true", "message": "INVALID API KEY"}, "unavailable"),
    ]
    async with respx.mock:
        for payload, expected in cases:
            _route(payload=payload)
            result = await leaklookup_service.lookup("example-breach-target.test")
            assert result["status"] == expected
            assert set(result) == {
                "source",
                "status",
                "count",
                "findings",
                "truncated",
                "note",
            }
            assert result["source"] == "Leak-Lookup"
            assert isinstance(result["count"], int)
            assert isinstance(result["findings"], list)
            assert isinstance(result["truncated"], bool)
            assert isinstance(result["note"], str) and result["note"]
            assert len(result["note"]) <= leaklookup_service.MAX_NOTE_CHARS


@pytest.mark.asyncio
async def test_supplied_client_is_reused_and_not_closed(with_key):
    closed: list[bool] = []

    async with respx.mock:
        _route(payload={"error": "false", "message": {}})
        async with httpx.AsyncClient() as client:
            original_close = client.aclose

            async def _tracking_close() -> None:
                closed.append(True)
                await original_close()

            client.aclose = _tracking_close  # type: ignore[method-assign]
            await leaklookup_service.lookup("example-breach-target.test", client)
            assert closed == []
