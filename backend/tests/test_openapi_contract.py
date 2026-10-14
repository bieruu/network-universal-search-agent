"""The OpenAPI contract: response models, error bodies, and the DNS block.

`/docs` is generated from the app, so these assertions are the only thing
keeping the generated schema honest. The three claims under test:

  1. Every endpoint declares a typed response model — the scanner of the API
     is a client reading /docs, not someone with the source.
  2. Every endpoint a session is required for documents 401, and the ones
     that can be rate-limited document 429, with the `{"detail": str}` body
     (or the list body for 422). Undocumented 4xx is how a client ends up
     treating a refused target as a dead backend.
  3. The DNS block of a scan snapshot is a typed `DnsLookupResult`, because
     that is the one source whose contract this repo owns end to end.

The disclosure question — whether /docs is exposed at all — is deliberately
NOT asserted here: `create_app()` already disables it in production, and
reversing that is an operator decision recorded in TODO.md, not a default.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.schemas.scan import ScanDetailResponse

AUTHED_ENDPOINTS = [
    ("get", "/api/v1/history"),
    ("get", "/api/v1/target/{t}/trend"),
    ("post", "/api/v1/scan"),
    ("get", "/api/v1/scan/{scan_id}"),
    ("get", "/health/sources"),
    ("post", "/api/v1/analysis/dns"),
]

PUBLIC_ENDPOINTS = [
    ("get", "/health"),
    ("get", "/ready"),
]


@pytest.fixture
def schema() -> dict:
    return create_app().openapi()


def test_every_path_declares_a_typed_response(schema):
    """An untyped response shows up as `object` with no properties in the schema."""
    untyped = []
    for path, operations in schema["paths"].items():
        for verb, operation in operations.items():
            response = operation.get("responses", {}).get("200", {})
            content = response.get("content", {})
            if not content:
                continue
            ref = content.get("application/json", {}).get("schema", {}).get("$ref", "")
            if not ref:
                untyped.append(f"{verb.upper()} {path}")
    assert untyped == [], f"endpoints without a response model: {untyped}"


@pytest.mark.parametrize("verb,path", AUTHED_ENDPOINTS)
def test_every_gated_endpoint_documents_401(verb, path, schema):
    responses = schema["paths"][path][verb]["responses"]
    assert (
        "401" in responses
    ), f"{verb.upper()} {path} is gated but does not document 401"


@pytest.mark.parametrize("verb,path", PUBLIC_ENDPOINTS)
def test_public_endpoints_stay_undocumented_as_errors(verb, path, schema):
    """A probe must not advertise auth errors it will never answer with."""
    responses = schema["paths"][path][verb]["responses"]
    assert set(responses) == {"200"}, f"{verb.upper()} {path} documents extra codes"


def test_error_bodies_are_documented_not_guessed(schema):
    post_scan = schema["paths"]["/api/v1/scan"]["post"]
    codes = post_scan["responses"]
    for code in ("400", "401", "422", "429", "503"):
        assert code in codes, f"POST /api/v1/scan does not document {code}"
    # 401/429 are the `{"detail": str}` shape this app raises.
    detail_ref = codes["401"]["content"]["application/json"]["schema"]["$ref"]
    assert detail_ref.endswith("/ErrorResponse")
    # 422 is FastAPI's request validation — a LIST body, not a string.
    validation_ref = codes["422"]["content"]["application/json"]["schema"]["$ref"]
    assert validation_ref.endswith("/ValidationErrorResponse")


def test_the_dns_block_of_a_scan_is_typed_in_the_schema(schema):
    scan_results = schema["components"]["schemas"]["ScanResults"]
    assert "dns" in scan_results["properties"]
    ref = scan_results["properties"]["dns"]["anyOf"][0]["$ref"]
    assert ref.endswith("/DnsLookupResult"), "the DNS block must stay typed"
    # Everything else passes through rather than being dropped.
    assert scan_results.get("additionalProperties") is not False


def test_health_sources_documents_its_vocabulary(schema):
    operation = schema["paths"]["/health/sources"]["get"]
    assert "401" in operation["responses"]
    source_status = schema["components"]["schemas"]["SourceStatus"]
    assert set(source_status["properties"]["status"]["enum"]) == {
        "ok",
        "degraded",
        "unknown",
    }, "unknown must stay a status of its own — a boolean up/down is a lie"


def test_partial_errors_keep_the_source_and_message_shape(schema):
    scan_detail = schema["components"]["schemas"]["ScanDetailResponse"]
    errors = scan_detail["properties"]["errors"]
    ref = errors["items"]["$ref"]
    assert ref.endswith("/SourceError")
    source_error = schema["components"]["schemas"]["SourceError"]
    assert set(source_error["required"]) == {"source", "message"}


def test_stored_snapshot_with_a_dns_block_round_trips_the_response_model():
    """The stored JSON must survive response validation unchanged."""
    snapshot = {
        "shodan": {"ports": [443]},
        "dns": {
            "source": "DNS",
            "domain": "example.com",
            "records": {"A": [{"value": "93.184.216.34", "ttl": 300}]},
            "counts_truncated": False,
            "missing": ["MX"],
            "errors": [{"type": "AAAA", "message": "timed out"}],
            "note": "AAAA could not be queried",
        },
        "_risk_breakdown": {"ports": 1.0},
    }
    model = ScanDetailResponse(
        scan_id="1" * 36,
        target="example.com",
        status="completed",
        risk_score=10,
        results=snapshot,
        errors=[{"source": "crtsh", "message": "unreachable"}],
    )

    dumped = model.model_dump()
    assert dumped["results"]["dns"]["records"]["A"][0]["value"] == "93.184.216.34"
    assert dumped["results"]["dns"]["missing"] == ["MX"]
    # Free-form source blocks are not dropped by the response model.
    assert dumped["results"]["shodan"] == {"ports": [443]}
    assert dumped["results"]["_risk_breakdown"] == {"ports": 1.0}


def test_docs_are_disabled_in_production(monkeypatch):
    """Not a choice this suite makes: the app refuses to expose /docs in prod.

    `is_production` is a property, so it is driven the way the app drives it:
    through APP_ENV. Leaving /docs exposed is an operator decision recorded in
    TODO.md; the production default here is the closed one.
    """
    monkeypatch.setenv("APP_ENV", "production")
    app = create_app()
    assert app.docs_url is None
    assert app.redoc_url is None
    assert app.openapi_url is None


def test_docs_are_reachable_outside_production():
    with TestClient(create_app()) as client:
        response = client.get("/docs")
    assert response.status_code == 200
