"""AlienVault OTX service tests.

No live network: every request is intercepted by `respx`, and the mock URL is
built from the real base so an unmatched route raises `AllMockedAssertionError`
instead of letting a real request to OTX escape.

The payloads below are the shapes verified against the live API on 2026-10-08,
including the parts that are actively misleading if taken at face value: the
always-`0` `reputation`, `base_indicator: {}`, `public: 1` as an integer, an
`author` object with no `author_name`, references that are not URLs, and a
`/malware/` target that is a web path rather than an API path.

The centre of gravity is `test_tlp_amber_and_red_withhold_name_and_description`:
an amber/red pulse must be counted and never shown.
"""

from __future__ import annotations

import json

import httpx
import pytest
import respx

from app.core.config import settings
from app.services import otx_service

API_KEY = "otx-test-key-abcdef0123456789"


def _pulse(**overrides):
    base = {
        "id": "5f2c9f8a1b2c3d4e5f607182",
        "name": "SmokeLoader C2 infrastructure",
        "description": "Command-and-control nodes observed in the wild.",
        "created": "2024-03-11T08:14:22",
        "modified": "2026-02-04T19:03:57",
        "tags": ["smokeloader", "c2", "windows"],
        "references": ["https://example.org/writeup"],
        "public": 1,
        "adversary": "TA569",
        "targeted_countries": ["Germany", "Austria"],
        "malware_families": [
            {
                "id": "family-1",
                "display_name": "Smoke Loader",
                "target": "/malware/Trojan:Win32/SmokeLoader",
            }
        ],
        "attack_ids": ["T1566.001"],
        "industries": ["finance"],
        "TLP": "white",
        "author": {"username": "analyst_one", "id": "user-7", "name": "Analyst One"},
        "indicator_type_counts": {"IPv4": 12, "domain": 3, "URL": 1},
        "subscriber_count": 44,
    }
    base.update(overrides)
    return base


def _general(
    pulses: list[dict] | None = None,
    *,
    count: int | None = None,
    base_indicator: dict | None = None,
    reputation: object = "sentinel",
    validation: list[dict] | None = None,
    false_positive: list[dict] | None = None,
    extra: dict | None = None,
) -> dict:
    pulses = [_pulse()] if pulses is None else pulses
    payload = {
        "whois": "https://whois.arin.net/rest/ip/8.8.8.8",
        "reputation": 0 if reputation == "sentinel" else reputation,
        "indicator": "8.8.8.8",
        "type": "IPv4",
        "type_title": "IPv4",
        "base_indicator": (
            {"id": "base-1", "type": "IPv4"}
            if base_indicator is None
            else base_indicator
        ),
        "pulse_info": {
            "count": len(pulses) if count is None else count,
            "pulses": pulses,
            "references": [],
            "related": {"domains": {}, "ipv4": {}},
        },
        "false_positive": false_positive or [],
        "validation": validation if validation is not None else [],
        "asn": "AS15169",
        "city": "Mountain View",
        "region": "California",
        "country_name": "United States",
        "country_code": "US",
        "continent_code": "NA",
        "latitude": 37.4056,
        "longitude": -122.0775,
        "postal_code": "94043",
    }
    if reputation == "absent":
        payload.pop("reputation")
    if extra:
        payload.update(extra)
    return payload


def _route(
    slug: str = "IPv4",
    value: str = "8.8.8.8",
    status: int = 200,
    payload=None,
    content: bytes | None = None,
):
    kwargs = {"content": content} if content is not None else {"json": payload}
    return respx.get(f"{otx_service.GENERAL_URL}/{slug}/{value}/general").mock(
        return_value=httpx.Response(status, **kwargs)
    )


def _set_key(monkeypatch, value: str) -> None:
    """Plant the key on the settings instance.

    `Settings.otx_api_key` exists (added with `scan_timeout_otx`), but this
    writes through `__dict__` so the test works unchanged against a config that
    predates the field. `monkeypatch` restores it afterwards.
    """
    monkeypatch.setitem(settings.__dict__, "otx_api_key", value)


@pytest.fixture
def no_key(monkeypatch):
    """Anonymous access — the verified default state."""
    _set_key(monkeypatch, "")


# --------------------------------------------------------------------------
# Happy path
# --------------------------------------------------------------------------


async def test_general_response_parses_count_findings_and_geo(no_key):
    payload = _general([_pulse(), _pulse(id="pulse-two", name="Second pulse")])
    async with respx.mock:
        _route(payload=payload)
        result = await otx_service.lookup("8.8.8.8")

        # Asserted INSIDE the context: respx clears `calls` on exit, so reading
        # `calls` afterwards would silently inspect nothing.
        request = respx.calls.last.request
        call_count = respx.calls.call_count

    assert result["status"] == "ok"
    assert result["count"] == result["pulse_count"] == 2
    assert result["truncated"] is False
    assert [f["name"] for f in result["findings"]] == [
        "SmokeLoader C2 infrastructure",
        "Second pulse",
    ]

    first = result["findings"][0]
    assert first["pulse_id"] == "5f2c9f8a1b2c3d4e5f607182"
    assert first["author"] == "analyst_one"
    assert first["tlp"] == "white"
    assert first["tlp_restricted"] is False
    assert first["adversary"] == "TA569"
    assert first["attack_ids"] == ["T1566.001"]
    assert first["targeted_countries"] == ["Germany", "Austria"]
    assert first["malware_families"] == ["Smoke Loader"]
    assert first["indicator_types"] == ["IPv4", "domain", "URL"]

    assert result["in_base_set"] is True
    assert result["validation"] == []
    assert result["false_positive"] == []

    geo = otx_service.extract_geo(payload)
    assert geo == {
        "asn": "AS15169",
        "country": "United States",
        "country_code": "US",
        "region": "California",
        "city": "Mountain View",
        "latitude": 37.4056,
        "longitude": -122.0775,
    }
    # One request only: /general already carries pulses and geo.
    assert call_count == 1
    assert str(request.url) == f"{otx_service.GENERAL_URL}/IPv4/8.8.8.8/general"
    assert request.headers["User-Agent"] == "osint-dashboard/1.0"


async def test_domain_target_uses_the_domain_slug(no_key):
    """`domain` is the slug; domain responses carry no reputation key at all."""
    payload = _general(
        [_pulse()],
        reputation="absent",
        extra={
            "indicator": "example-otx-target.test",
            "type": "domain",
            "type_title": "Domain",
            "sections": [
                "general",
                "geo",
                "url_list",
                "passive_dns",
                "malware",
                "whois",
                "http_scans",
            ],
            # A domain payload carries no endpoint-level geo either — only the
            # IP response does. Stripped here so the assertion below is about a
            # real domain shape rather than about the shared fixture.
            "asn": None,
            "city": None,
            "region": None,
            "country_name": None,
            "country_code": None,
            "latitude": None,
            "longitude": None,
            "postal_code": None,
        },
    )
    async with respx.mock:
        _route(slug="domain", value="example-otx-target.test", payload=payload)
        result = await otx_service.lookup("Example-OTX-Target.test.")
        url = str(respx.calls.last.request.url)

    assert result["status"] == "ok"
    assert result["count"] == 1
    # Case and the trailing dot are normalised; the slug is `domain`, not a type.
    assert url == f"{otx_service.GENERAL_URL}/domain/example-otx-target.test/general"
    # A domain payload has no asn/geo keys: absence is reported as None, not 0.
    assert otx_service.extract_geo(payload) == {
        "asn": None,
        "country": None,
        "country_code": None,
        "region": None,
        "city": None,
        "latitude": None,
        "longitude": None,
    }


async def test_ipv6_target_uses_ipv6_slug_and_reports_the_expanded_indicator(no_key):
    """OTX returns IPv6 expanded — the response value is echoed, not the input."""
    payload = _general(
        [_pulse()],
        extra={
            "indicator": "2001:4860:4860:0:0:0:0:8888",
            "type": "IPv6",
        },
    )
    async with respx.mock:
        _route(slug="IPv6", value="2001:4860:4860::8888", payload=payload)
        result = await otx_service.lookup("2001:4860:4860::8888")
        url = str(respx.calls.last.request.url)

    assert result["status"] == "ok"
    # The slug is capitalised `IPv6`, and the request carries our compressed form.
    assert url == f"{otx_service.GENERAL_URL}/IPv6/2001:4860:4860::8888/general"
    # Nothing in the output echoes our compressed input: the caller must read the
    # canonical form from the response, and this module does not launder it.
    assert "2001:4860:4860:0:0:0:0:8888" not in json.dumps(result)


# --------------------------------------------------------------------------
# THE safety test: TLP amber/red are counted but never shown
# --------------------------------------------------------------------------


@pytest.mark.parametrize("tlp", ["amber", "red", "AMBER", " red "])
async def test_tlp_amber_and_red_withhold_name_and_description(no_key, tlp):
    secret_name = "Undisclosed campaign against a named bank"
    secret_desc = "Victim names and IOCs are withheld under TLP."
    payload = _general(
        [
            _pulse(
                id="restricted-1", name=secret_name, description=secret_desc, TLP=tlp
            ),
            _pulse(id="open-2", name="Public pulse"),
        ]
    )
    async with respx.mock:
        _route(payload=payload)
        result = await otx_service.lookup("8.8.8.8")

    blob = json.dumps(result)
    restricted_finding, open_finding = result["findings"]

    assert restricted_finding["name"] == ""
    assert restricted_finding["description"] == ""
    assert restricted_finding["tlp_restricted"] is True
    assert restricted_finding["tlp"] == tlp.strip().lower()
    # Nothing that would identify the pulse survives anywhere in the payload.
    assert secret_name not in blob
    assert secret_desc not in blob

    # The non-restricted pulse is untouched.
    assert open_finding["name"] == "Public pulse"
    assert open_finding["tlp_restricted"] is False

    # ...and the count is unaffected: a hidden pulse is still a pulse.
    assert result["count"] == result["pulse_count"] == 2
    assert "TLP amber or red" in result["note"]


async def test_tlp_absent_is_not_invented(no_key):
    pulse = _pulse()
    pulse.pop("TLP")
    async with respx.mock:
        _route(payload=_general([pulse]))
        result = await otx_service.lookup("8.8.8.8")

    finding = result["findings"][0]
    # Nothing is inferred from absence: not white, not restricted.
    assert finding["tlp"] == ""
    assert finding["tlp_restricted"] is False
    assert finding["name"] == "SmokeLoader C2 infrastructure"


async def test_unrecognised_tlp_value_is_dropped_not_guessed(no_key):
    async with respx.mock:
        _route(payload=_general([_pulse(TLP="chartreuse")]))
        result = await otx_service.lookup("8.8.8.8")

    assert result["findings"][0]["tlp"] == ""
    assert result["findings"][0]["tlp_restricted"] is False


# --------------------------------------------------------------------------
# reputation is NOT a risk score
# --------------------------------------------------------------------------


@pytest.mark.parametrize("reputation", [0, None])
async def test_reputation_is_never_returned_as_a_score(no_key, reputation):
    """`0` and `null` are both passed over, and neither becomes a verdict.

    `/general` returns an always-`0` integer for IPs and `/reputation` returned
    `null` for every IP probed anonymously. A `0` could be the clamped floor of
    a negative scale, a "not scored" default, or genuinely neutral — so the
    module does not put it in the output at all, and `count`/`note` carry the
    legible meaning instead.
    """
    async with respx.mock:
        _route(payload=_general([_pulse()], reputation=reputation))
        result = await otx_service.lookup("8.8.8.8")

    blob = json.dumps(result).lower()
    assert result["status"] == "ok"
    # The raw field is absent from the contract entirely — not renamed, not
    # wrapped, not zeroed.
    assert "reputation" not in result
    assert "reputation" not in blob
    # No risk verdict is invented either: no score, no grade, no verdict field.
    assert "risk" not in blob
    assert "score" not in result
    assert "verdict" not in result
    # The only safety language in the payload is the disclaimer, never a claim.
    assert "not that the target is safe" in result["note"]
    # The legible signals are present and drive the note.
    assert result["count"] == 1
    assert "not a confirmed finding" in result["note"]
    # And the pulse's own text is still fully visible: suppression is about
    # severity claims, not about hiding community data.
    assert result["findings"][0]["name"] == "SmokeLoader C2 infrastructure"


async def test_a_whitelisted_indicator_is_reported_through_validation_not_a_score(
    no_key,
):
    """`validation[]` is where OTX states a benign verdict. Use it."""
    async with respx.mock:
        _route(
            payload=_general(
                [_pulse()],
                reputation=None,
                base_indicator={},
                validation=[
                    {
                        "source": "whitelist",
                        "message": "contained in whitelisted prefix",
                        "name": "Whitelisted IP",
                    },
                    {
                        "source": "false_positive",
                        "message": "Known False Positive",
                        "name": "",
                    },
                ],
                false_positive=[
                    {
                        "assessment": "Benign hosting range",
                        "assessment_date": "2024-06-01",
                        "report_date": "2024-05-28",
                    }
                ],
            )
        )
        result = await otx_service.lookup("8.8.8.8")

    assert [v["source"] for v in result["validation"]] == [
        "whitelist",
        "false_positive",
    ]
    assert result["validation"][0]["message"] == "contained in whitelisted prefix"
    assert result["false_positive"][0]["assessment"] == "Benign hosting range"
    # Still not in the base set — which is NOT benign.
    assert result["in_base_set"] is False
    # A whitelisted verdict is never turned into a blanket "safe" claim: it is
    # passed through as OTX's own words, next to a pulse that still mentions the
    # indicator, so the reader can see both.
    assert result["count"] == 1
    assert "not that the target is safe" in result["note"]


# --------------------------------------------------------------------------
# Empty state — keying off the count, NOT off a 404
# --------------------------------------------------------------------------


async def test_zero_pulses_is_ok_with_count_zero_and_is_not_an_error(no_key):
    """No OTX presence is HTTP 200 + count 0, not a 404 and not a failure."""
    payload = _general([], count=0, base_indicator={}, reputation=None)
    async with respx.mock:
        _route(payload=payload)
        result = await otx_service.lookup("8.8.8.8")

    assert result["status"] == "ok"
    assert result["count"] == result["pulse_count"] == 0
    assert result["findings"] == []
    assert result["truncated"] is False
    assert result["note"]
    assert "nothing has been shared" in result["note"]


async def test_empty_base_indicator_is_not_reported_as_benign(no_key):
    async with respx.mock:
        _route(payload=_general([], count=0, base_indicator={}))
        result = await otx_service.lookup("8.8.8.8")

    assert result["status"] == "ok"
    assert result["in_base_set"] is False
    # The note must not read the absence of a base-set entry as a clean bill —
    # it says the opposite, and says it in those words.
    assert "not that the target is safe or benign" in result["note"]
    assert "nothing has been shared" in result["note"]


async def test_non_empty_base_indicator_means_in_base_set_only(no_key):
    async with respx.mock:
        _route(payload=_general([_pulse()], base_indicator={"id": "base-1"}))
        result = await otx_service.lookup("8.8.8.8")

    assert result["in_base_set"] is True
    # In the base set is not a verdict either; the note never says so.
    assert "clean" not in result["note"].lower()


# --------------------------------------------------------------------------
# Caps and the honesty of truncation
# --------------------------------------------------------------------------


async def test_a_300_tag_pulse_is_capped_at_20(no_key):
    pulse = _pulse(tags=[f"tag-{i:03d}" for i in range(300)])
    async with respx.mock:
        _route(payload=_general([pulse]))
        result = await otx_service.lookup("8.8.8.8")

    tags = result["findings"][0]["tags"]
    assert len(tags) == otx_service.MAX_LIST_ITEMS == 20
    assert tags[0] == "tag-000"
    assert tags[-1] == "tag-019"
    # Per-pulse list capping does not make the RESULT truncated: the pulse list
    # itself is complete, so claiming truncation here would be a false alarm.
    assert result["truncated"] is False
    assert result["count"] == 1


async def test_findings_are_capped_at_500_and_count_stays_the_full_total(no_key):
    pulses = [_pulse(id=f"pulse-{i:04d}", name=f"Pulse {i}") for i in range(600)]
    async with respx.mock:
        _route(payload=_general(pulses, count=600))
        result = await otx_service.lookup("8.8.8.8")

    assert result["status"] == "ok"
    assert len(result["findings"]) == otx_service.MAX_FINDINGS == 500
    assert result["truncated"] is True
    # The headline number is the true total, not the capped view.
    assert result["count"] == 600
    assert "full total" in result["note"]


async def test_reference_list_is_capped_at_10_entries_of_200_chars(no_key):
    pulse = _pulse(references=["r" * 500] + [f"ref-{i}" for i in range(30)])
    async with respx.mock:
        _route(payload=_general([pulse]))
        result = await otx_service.lookup("8.8.8.8")

    references = result["findings"][0]["references"]
    assert len(references) == otx_service.MAX_REFERENCE_ITEMS == 10
    assert len(references[0]) == otx_service.MAX_REFERENCE_CHARS == 200


async def test_field_lengths_are_bounded(no_key):
    pulse = _pulse(
        name="N" * 900,
        description="D" * 4000,
        created="C" * 200,
        modified="M" * 200,
        adversary="A" * 400,
        malware_families=[{"display_name": "F" * 400}],
        tags=["t" * 300],
        targeted_countries=["c" * 300],
        attack_ids=["a" * 300],
    )
    async with respx.mock:
        _route(payload=_general([pulse]))
        finding = (await otx_service.lookup("8.8.8.8"))["findings"][0]

    assert len(finding["name"]) == otx_service.MAX_NAME_CHARS == 200
    assert len(finding["description"]) == otx_service.MAX_DESC_CHARS == 500
    assert len(finding["created"]) == otx_service.MAX_DATE_CHARS == 40
    assert len(finding["modified"]) == 40
    assert len(finding["adversary"]) == otx_service.MAX_ADVERSARY_CHARS == 120
    assert len(finding["malware_families"][0]) == otx_service.MAX_FAMILY_CHARS == 120
    assert len(finding["tags"][0]) == otx_service.MAX_TAG_CHARS == 60
    assert len(finding["targeted_countries"][0]) == otx_service.MAX_COUNTRY_CHARS == 80
    assert len(finding["attack_ids"][0]) == 60
    assert len(finding["pulse_id"]) <= otx_service.MAX_ID_CHARS


# --------------------------------------------------------------------------
# References are plain text, not links
# --------------------------------------------------------------------------


async def test_references_with_non_url_junk_are_kept_as_plain_text(no_key):
    """Observed references are malware names and concatenated notes, not URLs.

    They are truncated and passed through verbatim. This module emits no URL at
    all, so a caller cannot mistake one for a link.
    """
    hybrid_blob = "HybridAnalysis:run=1;" * 70
    pulse = _pulse(
        references=[
            "Trojan:Win32/SmokeLoader",
            "Google -> pnseab-ac-in-f14.1e100.net = 1e100.net",
            hybrid_blob,
            "https://example.org/real-writeup",
        ]
    )
    async with respx.mock:
        _route(payload=_general([pulse]))
        result = await otx_service.lookup("8.8.8.8")

    references = result["findings"][0]["references"]
    assert references[0] == "Trojan:Win32/SmokeLoader"
    assert references[1] == "Google -> pnseab-ac-in-f14.1e100.net = 1e100.net"
    assert len(references[2]) == otx_service.MAX_REFERENCE_CHARS
    assert references[3] == "https://example.org/real-writeup"
    # No link-shaped wrapping, no scheme injection into a rendered field.
    assert "href" not in json.dumps(result)
    assert "<a " not in json.dumps(result)


async def test_malware_family_target_is_never_built_into_a_url(no_key):
    """`target` is a web path, not an API path, so it is dropped entirely."""
    pulse = _pulse(
        malware_families=[
            {
                "id": "f1",
                "display_name": "Smoke Loader",
                "target": "/malware/Trojan:Win32/SmokeLoader",
            }
        ]
    )
    async with respx.mock:
        _route(payload=_general([pulse]))
        result = await otx_service.lookup("8.8.8.8")
        call_count = respx.calls.call_count

    assert result["findings"][0]["malware_families"] == ["Smoke Loader"]
    assert "/malware/Trojan" not in json.dumps(result)
    assert call_count == 1  # no follow-up request for the family page


# --------------------------------------------------------------------------
# Shape quirks verified live
# --------------------------------------------------------------------------


async def test_public_one_integer_is_handled_truthily(no_key):
    """`public` is documented boolean but arrives as the integer 1.

    `is True` would drop every real pulse, so the value is read truthily. The
    field is not in the output contract; this test exists to prove nothing
    downstream depends on the boolean comparison.
    """
    pulse = _pulse(public=1)
    async with respx.mock:
        _route(payload=_general([pulse]))
        result = await otx_service.lookup("8.8.8.8")

    assert result["status"] == "ok"
    assert result["count"] == 1
    assert len(result["findings"]) == 1


async def test_author_object_is_read_from_username(no_key):
    async with respx.mock:
        _route(
            payload=_general([_pulse(author={"username": "otx_user_42", "id": "u42"})])
        )
        result = await otx_service.lookup("8.8.8.8")

    assert result["findings"][0]["author"] == "otx_user_42"


async def test_author_name_string_is_read_when_there_is_no_author_object(no_key):
    """`GET /pulses/{id}` carries `author_name` and no `author` object."""
    pulse = _pulse(author_name="someone_else")
    pulse.pop("author")
    async with respx.mock:
        _route(payload=_general([pulse]))
        result = await otx_service.lookup("8.8.8.8")

    assert result["findings"][0]["author"] == "someone_else"


async def test_both_author_shapes_absent_is_an_empty_string(no_key):
    pulse = _pulse()
    pulse.pop("author")
    async with respx.mock:
        _route(payload=_general([pulse]))
        result = await otx_service.lookup("8.8.8.8")

    assert result["findings"][0]["author"] == ""


async def test_pulses_without_a_usable_id_are_skipped(no_key):
    payload = _general([_pulse(id=""), _pulse(id=None), _pulse(id="keep-me")])
    async with respx.mock:
        _route(payload=payload)
        result = await otx_service.lookup("8.8.8.8")

    # The count is OTX's number; the list only holds referencable pulses.
    assert result["count"] == 3
    assert [f["pulse_id"] for f in result["findings"]] == ["keep-me"]


async def test_control_characters_and_escapes_are_stripped_from_pulse_text(no_key):
    pulse = _pulse(name="\x1b[31mRed pulse\x1b[0m", tags=["\x07beep", "\x00\x1b[0m"])
    async with respx.mock:
        _route(payload=_general([pulse]))
        result = await otx_service.lookup("8.8.8.8")

    finding = result["findings"][0]
    assert finding["name"] == "Red pulse"
    assert finding["tags"] == ["beep"]
    assert "\x1b" not in json.dumps(result)


# --------------------------------------------------------------------------
# Key handling
# --------------------------------------------------------------------------


async def test_anonymous_request_sends_no_api_key_header(no_key):
    """OTX_API_KEY is optional; /general works fully anonymously."""
    async with respx.mock:
        _route(payload=_general([_pulse()]))
        result = await otx_service.lookup("8.8.8.8")
        request = respx.calls.last.request

    assert result["status"] == "ok"
    assert "X-OTX-API-KEY" not in request.headers


async def test_a_configured_key_is_sent_raw_and_never_echoed(monkeypatch):
    _set_key(monkeypatch, API_KEY)
    async with respx.mock:
        _route(payload=_general([_pulse()]))
        result = await otx_service.lookup("8.8.8.8")
        request = respx.calls.last.request

    # Raw key: no Bearer prefix, no `OTX-API-KEY` label in the value.
    assert request.headers["X-OTX-API-KEY"] == API_KEY
    assert not request.headers["X-OTX-API-KEY"].lower().startswith("bearer")
    assert API_KEY not in json.dumps(result)


async def test_a_rejected_key_is_never_echoed_into_the_note(monkeypatch):
    _set_key(monkeypatch, API_KEY)
    async with respx.mock:
        _route(
            status=403,
            payload={"detail": "Invalid API key supplied", "errors": ["bad key"]},
        )
        result = await otx_service.lookup("8.8.8.8")

    blob = json.dumps(result)
    assert result["status"] == "unavailable"
    assert API_KEY not in blob
    assert "OTX_API_KEY" in result["note"]
    assert "never shown" in result["note"]


async def test_a_whitespace_only_key_is_treated_as_anonymous(monkeypatch):
    _set_key(monkeypatch, "   ")
    async with respx.mock:
        _route(payload=_general([_pulse()]))
        result = await otx_service.lookup("8.8.8.8")
        request = respx.calls.last.request

    assert result["status"] == "ok"
    assert "X-OTX-API-KEY" not in request.headers


async def test_a_transport_error_echoing_the_key_is_scrubbed(monkeypatch):
    """sanitize_error strips key-shaped text out of an httpx exception message."""
    _set_key(monkeypatch, API_KEY)
    hostile = (
        "connection failed for https://otx.alienvault.com/api/v1"
        f"/indicators/IPv4/8.8.8.8/general?X-OTX-API-KEY={API_KEY}"
    )
    async with respx.mock:
        _route(slug="IPv4", value="8.8.8.8").mock(
            side_effect=httpx.ConnectError(hostile)
        )
        result = await otx_service.lookup("8.8.8.8")

    assert result["status"] == "unavailable"
    assert API_KEY not in json.dumps(result)


# --------------------------------------------------------------------------
# 429 is overloaded — the body decides, never the status code
# --------------------------------------------------------------------------


async def test_quota_429_is_unavailable_with_the_anonymous_limit_named(no_key):
    async with respx.mock:
        _route(status=429, payload={"detail": "Over throttling limit (100/hour)"})
        result = await otx_service.lookup("8.8.8.8")
        call_count = respx.calls.call_count

    assert call_count == 1  # no retry loop against an hourly per-IP quota
    assert result["status"] == "unavailable"
    assert "100 requests/hour" in result["note"]
    assert result["count"] == 0
    assert result["findings"] == []


async def test_anonymous_access_429_is_not_configured_not_unavailable(no_key):
    """The same status code, a different body, a different status and note."""
    async with respx.mock:
        _route(
            status=429,
            payload={
                "detail": (
                    "Anonymous access to this endpoint is limited. "
                    "Please authenticate."
                )
            },
        )
        result = await otx_service.lookup("8.8.8.8")

    assert result["status"] == "not_configured"
    assert "OTX_API_KEY" in result["note"]


async def test_anonymous_access_403_is_also_not_configured(no_key):
    async with respx.mock:
        _route(
            status=403,
            payload={
                "detail": (
                    "Anonymous access to this endpoint is limited. "
                    "Please authenticate."
                )
            },
        )
        result = await otx_service.lookup("8.8.8.8")

    assert result["status"] == "not_configured"


async def test_a_bad_key_403_is_unavailable_not_not_configured(monkeypatch):
    """A configured key that OTX rejects is a failure, not a missing setting."""
    _set_key(monkeypatch, API_KEY)
    async with respx.mock:
        _route(status=403, payload={"detail": "Forbidden"})
        result = await otx_service.lookup("8.8.8.8")

    assert result["status"] == "unavailable"
    assert "not_configured" not in result["status"]


async def test_an_unclassifiable_429_is_unavailable_not_a_key_problem(no_key):
    """Without the body there is no evidence a key is what is missing."""
    async with respx.mock:
        _route(status=429, content=b"")
        result = await otx_service.lookup("8.8.8.8")

    assert result["status"] == "unavailable"
    assert "rate limiting" in result["note"].lower()


# --------------------------------------------------------------------------
# Refused targets — no request may be spent
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "target",
    [
        "127.0.0.1",
        "10.0.0.5",
        "192.168.1.1",
        "169.254.169.254",
        "localhost",
        "::1",
        "fd00::1",
    ],
    ids=[
        "loopback-v4",
        "rfc1918-10",
        "rfc1918-192",
        "link-local",
        "localhost-name",
        "loopback-v6",
        "ula-v6",
    ],
)
async def test_private_and_local_targets_are_never_queried(no_key, target):
    async with respx.mock:
        result = await otx_service.lookup(target)

    assert result["status"] == "unavailable"
    assert not respx.calls.called
    assert "not sent" in result["note"]


@pytest.mark.parametrize(
    "target",
    [
        "person@example-otx-target.test",
        "",
        "   ",
        "https://example.org/path",
        "not a target",
        "single-label",
        "bad_label.test",
    ],
    ids=["email", "empty", "whitespace", "url", "spaces", "single-label", "underscore"],
)
async def test_unsupported_targets_are_never_queried(no_key, target):
    async with respx.mock:
        result = await otx_service.lookup(target)

    assert result["status"] == "unavailable"
    assert not respx.calls.called
    assert result["note"]


async def test_a_non_string_target_is_reported_not_raised(no_key):
    async with respx.mock:
        result = await otx_service.lookup(None)  # type: ignore[arg-type]

    assert result["status"] == "unavailable"
    assert not respx.calls.called


# --------------------------------------------------------------------------
# Failure modes — never raise
# --------------------------------------------------------------------------


async def test_timeout_is_unavailable(no_key):
    async with respx.mock:
        _route().mock(side_effect=httpx.ReadTimeout("timed out"))
        result = await otx_service.lookup("8.8.8.8")

    assert result["status"] == "unavailable"
    assert "timed out" in result["note"].lower()


async def test_transport_failure_is_unavailable(no_key):
    async with respx.mock:
        _route().mock(side_effect=httpx.ConnectError("no route"))
        result = await otx_service.lookup("8.8.8.8")

    assert result["status"] == "unavailable"
    assert "AlienVault OTX" in result["note"]


async def test_server_error_is_unavailable(no_key):
    async with respx.mock:
        _route(status=503, payload={"detail": "service unavailable"})
        result = await otx_service.lookup("8.8.8.8")

    assert result["status"] == "unavailable"
    assert "503" in result["note"]


async def test_non_json_response_is_unavailable(no_key):
    async with respx.mock:
        _route(content=b"<html>gateway error</html>")
        result = await otx_service.lookup("8.8.8.8")

    assert result["status"] == "unavailable"
    assert "not JSON" in result["note"]


@pytest.mark.parametrize(
    "payload",
    [
        [],
        "a bare string",
        {"pulse_info": "not-a-dict"},
        {"no": "keys", "at": "all"},
        {"pulse_info": None},
        {"pulse_info": {"pulses": "not-a-list", "count": "not-an-int"}},
        {"pulse_info": {"pulses": [None, "string", 7], "count": 3}},
    ],
    ids=[
        "list",
        "string",
        "pulse-info-string",
        "junk",
        "null-pulse-info",
        "pulses-not-list",
        "pulses-junk-entries",
    ],
)
async def test_malformed_payloads_are_handled_without_raising(no_key, payload):
    async with respx.mock:
        _route(payload=payload)
        result = await otx_service.lookup("8.8.8.8")

    assert result["status"] in {"ok", "unavailable"}
    assert isinstance(result["count"], int)
    assert isinstance(result["findings"], list)
    assert result["note"]


async def test_missing_pulse_info_is_unavailable_not_zero_pulses(no_key):
    """A wrong shape must not be indistinguishable from "nobody wrote a pulse"."""
    async with respx.mock:
        _route(payload={"indicator": "8.8.8.8", "type": "IPv4"})
        result = await otx_service.lookup("8.8.8.8")

    assert result["status"] == "unavailable"
    assert result["count"] == 0
    assert result["findings"] == []
    assert "no pulse_info" in result["note"]


# --------------------------------------------------------------------------
# extract_geo — pure function, no network
# --------------------------------------------------------------------------


def test_extract_geo_returns_none_not_zero_for_absent_fields():
    geo = otx_service.extract_geo({"indicator": "8.8.8.8"})

    assert geo == {
        "asn": None,
        "country": None,
        "country_code": None,
        "region": None,
        "city": None,
        "latitude": None,
        "longitude": None,
    }
    # 0.0 latitude is the Gulf of Guinea and 0 is a real ASN: neither is absence,
    # so absence must read as None all the way through.


def test_extract_geo_accepts_zero_coordinates_as_real_values():
    """A genuine 0.0 coordinate is data, not absence — the reverse mistake."""
    geo = otx_service.extract_geo({"latitude": 0.0, "longitude": 0})

    assert geo["latitude"] == 0.0
    assert geo["longitude"] == 0.0


def test_extract_geo_rejects_non_numeric_and_nan_coordinates():
    geo = otx_service.extract_geo(
        {"latitude": "37.4", "longitude": float("nan"), "city": {"name": "Nope"}}
    )

    assert geo["latitude"] is None
    assert geo["longitude"] is None
    assert geo["city"] is None


def test_extract_geo_tolerates_a_non_dict_payload():
    assert otx_service.extract_geo(None)["asn"] is None  # type: ignore[arg-type]
    assert otx_service.extract_geo("junk")["country"] is None  # type: ignore[arg-type]


def test_extract_geo_falls_back_from_country_name_to_country():
    assert otx_service.extract_geo({"country": "Japan"})["country"] == "Japan"


# --------------------------------------------------------------------------
# Contract shape
# --------------------------------------------------------------------------


async def test_every_result_carries_exactly_the_contract_keys(no_key):
    """One assertion over the happy, empty, throttled, refused and error paths."""
    # (payload, expected status, HTTP status the route should return)
    cases = [
        (_general([_pulse()]), "ok", 200),
        (_general([], count=0), "ok", 200),
        ({"detail": "Over throttling limit (100/hour)"}, "unavailable", 429),
        (
            {"detail": "Anonymous access to this endpoint is limited."},
            "not_configured",
            429,
        ),
        ({"indicator": "8.8.8.8"}, "unavailable", 200),
    ]
    expected_keys = {
        "source",
        "status",
        "count",
        "findings",
        "truncated",
        "note",
        "pulse_count",
        "in_base_set",
        "validation",
        "false_positive",
    }
    finding_keys = {
        "pulse_id",
        "name",
        "description",
        "created",
        "modified",
        "author",
        "tlp",
        "tlp_restricted",
        "tags",
        "malware_families",
        "adversary",
        "attack_ids",
        "targeted_countries",
        "indicator_types",
        "references",
    }
    async with respx.mock:
        for payload, expected, status in cases:
            _route(status=status, payload=payload)
            result = await otx_service.lookup("8.8.8.8")

            assert set(result) == expected_keys
            assert result["source"] == "AlienVault OTX"
            assert result["status"] == expected
            assert isinstance(result["count"], int)
            assert isinstance(result["pulse_count"], int)
            assert isinstance(result["in_base_set"], bool)
            assert isinstance(result["findings"], list)
            assert isinstance(result["validation"], list)
            assert isinstance(result["false_positive"], list)
            assert isinstance(result["truncated"], bool)
            assert result["note"] and len(result["note"]) <= otx_service.MAX_NOTE_CHARS
            for finding in result["findings"]:
                assert set(finding) == finding_keys


async def test_timeout_is_bounded_by_the_config_pattern(no_key):
    async with respx.mock:
        _route(payload=_general([_pulse()]))
        await otx_service.lookup("8.8.8.8")
        extensions = respx.calls.last.request.extensions["timeout"]

    assert otx_service._timeout_seconds() == settings.scan_timeout_otx == 12.0
    assert extensions["connect"] == 12.0


async def test_supplied_client_is_reused_and_not_closed(no_key):
    closed: list[bool] = []

    async with respx.mock:
        _route(payload=_general([_pulse()]))
        async with httpx.AsyncClient() as client:
            original_close = client.aclose

            async def _tracking_close() -> None:
                closed.append(True)
                await original_close()

            client.aclose = _tracking_close  # type: ignore[method-assign]
            result = await otx_service.lookup("8.8.8.8", client)
            assert closed == []
            # The User-Agent is set even for a caller-supplied client.
            assert (
                respx.calls.last.request.headers["User-Agent"] == "osint-dashboard/1.0"
            )

    assert result["status"] == "ok"
    assert closed == []  # untouched after the call, not closed by us
