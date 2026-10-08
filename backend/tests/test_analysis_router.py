"""Router-level tests for the v2 analysis endpoints.

The service modules are tested individually by their own files. What is tested
HERE is the contract the router owns and the services cannot: auth, rate-limit
bucketing, the HTTP-200-with-errors[] rule, URL normalisation, the cache, and
the boundary between "caller mistake" (4xx) and "upstream/policy failure" (200).

No test in this file touches the network. Services are monkeypatched, and where
the SSRF guard is genuinely part of the assertion (blocked target, pinned IP)
the resolver seam and respx are used instead.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from app.core import cache as cache_mod
from app.core import rate_limit, ssrf
from app.core.config import settings
from app.core.security import require_user
from app.db.session import get_session
from app.main import create_app
from app.routers import analysis as analysis_router

PUBLIC_IP = "93.184.216.34"


@pytest.fixture
def client(monkeypatch) -> Iterator[TestClient]:
    """Authenticated client with the rate limiter reset around every test."""
    monkeypatch.setattr(settings, "free_rate_limit_per_hour", 5)
    rate_limit.reset_for_tests()

    # Cache off by default so a test cannot pass on a previous test's entry.
    async def _miss(key: str) -> None:
        return None

    async def _noop(key: str, value: Any, ttl: int) -> None:
        return None

    monkeypatch.setattr(cache_mod, "cache_get_async", _miss)
    monkeypatch.setattr(cache_mod, "cache_set_async", _noop)

    app = create_app()
    app.dependency_overrides[require_user] = lambda: "user:test"
    app.dependency_overrides[get_session] = lambda: None
    with TestClient(app) as c:
        yield c
    rate_limit.reset_for_tests()


def _patch(monkeypatch, module: Any, result: Any) -> list[dict[str, Any]]:
    """Replace a service's lookup with a canned result; record its calls."""
    calls: list[dict[str, Any]] = []

    async def _fake(url: Any, *args: Any, **kwargs: Any) -> Any:
        calls.append({"url": url, "args": args, "kwargs": kwargs})
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(module, "lookup", _fake)
    return calls


# --- auth -------------------------------------------------------------------


@pytest.mark.parametrize(
    "path,payload",
    [
        ("/api/v1/analysis/headers", {"url": "https://example.com"}),
        ("/api/v1/analysis/redirects", {"url": "https://example.com"}),
        ("/api/v1/analysis/sitemap", {"url": "https://example.com"}),
        ("/api/v1/analysis/contacts", {"url": "https://example.com"}),
        ("/api/v1/analysis/dns", {"target": "example.com"}),
        ("/api/v1/analysis/tls", {"target": "example.com"}),
        ("/api/v1/analysis/exif", {"data": "aGk="}),
        ("/api/v1/analysis/phone/+6281234567890", None),
    ],
)
def test_every_analysis_endpoint_requires_auth(monkeypatch, path, payload):
    # No dependency override here: this asserts the real require_user() runs.
    app = create_app()
    with TestClient(app) as unauthed:
        response = unauthed.post(path, json=payload) if payload else unauthed.get(path)
    assert response.status_code in (
        401,
        503,
    ), f"{path} answered {response.status_code} without a session"


# --- the 200-with-errors[] rule --------------------------------------------


@pytest.mark.parametrize(
    "path,payload,module",
    [
        (
            "/api/v1/analysis/headers",
            {"url": "https://example.com"},
            "http_headers_service",
        ),
        (
            "/api/v1/analysis/redirects",
            {"url": "https://example.com"},
            "redirect_service",
        ),
        ("/api/v1/analysis/sitemap", {"url": "https://example.com"}, "sitemap_service"),
        (
            "/api/v1/analysis/contacts",
            {"url": "https://example.com"},
            "contact_service",
        ),
    ],
)
def test_upstream_failure_is_200_with_errors_not_a_500(
    client, monkeypatch, path, payload, module
):
    from app import services

    _patch(
        monkeypatch,
        getattr(services, module),
        ssrf.SsrfTimeout(f"{module}: timed out after 10s"),
    )
    response = client.post(path, json=payload)

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "error"
    assert body["errors"] and body["errors"][0]["source"]
    # The service's own timing text is surfaced, but nothing is fabricated.
    assert "timed out" in body["errors"][0]["message"]


@pytest.mark.parametrize(
    "path,payload,module",
    [
        (
            "/api/v1/analysis/headers",
            {"url": "https://example.com"},
            "http_headers_service",
        ),
        (
            "/api/v1/analysis/redirects",
            {"url": "https://example.com"},
            "redirect_service",
        ),
        ("/api/v1/analysis/sitemap", {"url": "https://example.com"}, "sitemap_service"),
        (
            "/api/v1/analysis/contacts",
            {"url": "https://example.com"},
            "contact_service",
        ),
    ],
)
def test_transport_error_is_200_and_leaks_no_internals(
    client, monkeypatch, path, payload, module
):
    from app import services

    _patch(
        monkeypatch,
        getattr(services, module),
        httpx.ConnectError("dial failed for super-secret-host"),
    )
    response = client.post(path, json=payload)

    assert response.status_code == 200
    message = response.json()["errors"][0]["message"]
    # Only the exception type, never the upstream text (AGENTS.md §5.4).
    assert "ConnectError" in message
    assert "super-secret-host" not in message


def test_blocked_target_is_reported_as_an_error_not_as_no_findings(client, monkeypatch):
    """A refused target must never read as "this site has no headers"."""
    from app.services import http_headers_service

    _patch(
        monkeypatch,
        http_headers_service,
        ssrf.SsrfBlocked("example.com: resolves to a blocked address (127.0.0.1)"),
    )
    body = client.post(
        "/api/v1/analysis/headers", json={"url": "https://example.com"}
    ).json()

    assert body["status"] == "error"
    assert "blocked address" in body["errors"][0]["message"]
    assert body["data"] == {}


def test_whole_chain_to_the_real_guard_blocks_a_private_address(client, monkeypatch):
    """End-to-end through the real SafeFetcher: nothing is fetched when blocked."""
    from app.services import http_headers_service

    # Not patched — this exercises the guard the router depends on.
    assert http_headers_service.lookup is not None
    monkeypatch.setattr(ssrf, "_sync_resolve_all", lambda host, port: ["127.0.0.1"])
    body = client.post(
        "/api/v1/analysis/headers", json={"url": "https://example.com"}
    ).json()

    assert body["status"] == "error"
    assert "blocked" in body["errors"][0]["message"].lower()


def test_a_public_target_reaches_the_network_through_the_pinned_ip(client, monkeypatch):
    """The happy path, end to end: guard resolves, pins, and the service sees a URL."""
    monkeypatch.setattr(ssrf, "_sync_resolve_all", lambda host, port: [PUBLIC_IP])
    with respx.mock:
        route = respx.get(f"https://{PUBLIC_IP}/").mock(
            return_value=httpx.Response(
                200,
                headers=[("server", "nginx"), ("set-cookie", "a=secretvalue; Path=/")],
            )
        )
        body = client.post(
            "/api/v1/analysis/headers", json={"url": "https://example.com"}
        ).json()

    assert body["status"] == "ok"
    assert route.calls, "the pinned-IP request must actually be made"
    assert route.calls[0].request.headers["host"] == "example.com"
    # The cookie VALUE is a credential and must not survive the round trip.
    assert "secretvalue" not in str(body)


# --- URL normalisation ------------------------------------------------------


@pytest.mark.parametrize(
    "supplied,expected",
    [
        ("example.com", "https://example.com/"),
        ("https://example.com", "https://example.com/"),
        ("example.com/some/path", "https://example.com/some/path"),
        ("http://example.com", "http://example.com/"),
        ("example.com:8443", "https://example.com:8443/"),
    ],
)
def test_url_normalisation(client, monkeypatch, supplied, expected):
    from app.services import http_headers_service

    calls = _patch(
        monkeypatch, http_headers_service, {"source": "HTTP response", "status": 200}
    )
    client.post("/api/v1/analysis/headers", json={"url": supplied})
    assert calls[0]["url"] == expected


@pytest.mark.parametrize(
    "bad", ["ftp://example.com", "javascript:alert(1)", "not a url"]
)
def test_non_http_urls_are_400(client, bad):
    assert client.post("/api/v1/analysis/headers", json={"url": bad}).status_code == 400


def test_private_host_is_rejected_before_the_service_runs(client, monkeypatch):
    """The string check is defence in depth; the guard is the real gate."""
    from app.services import http_headers_service

    calls = _patch(
        monkeypatch, http_headers_service, {"source": "HTTP response", "status": 200}
    )
    for target in ("http://127.0.0.1/", "http://localhost/", "http://169.254.169.254/"):
        response = client.post("/api/v1/analysis/headers", json={"url": target})
        assert response.status_code == 400, target
    assert calls == [], "a blocked host must never reach the service"


# --- DNS --------------------------------------------------------------------


def test_dns_returns_the_service_shape(client, monkeypatch):
    from app.services import dns_service

    _patch(
        monkeypatch,
        dns_service,
        {"source": "DNS", "domain": "example.com", "records": {"A": []}},
    )
    body = client.post("/api/v1/analysis/dns", json={"target": "Example.COM."}).json()

    assert body["status"] == "ok"
    assert body["data"]["source"] == "DNS"


def test_dns_rejects_an_ip_literal_with_400(client, monkeypatch):
    from app.services import dns_service

    async def _reject(target: str, *args: Any, **kwargs: Any) -> Any:
        raise ValueError("DNS records are not meaningful for an IP address")

    monkeypatch.setattr(dns_service, "lookup", _reject)
    response = client.post("/api/v1/analysis/dns", json={"target": PUBLIC_IP})

    assert response.status_code == 400
    assert "IP address" in response.json()["detail"]


# --- phone ------------------------------------------------------------------


def test_phone_endpoint_is_offline_and_validates_format(client):
    body = client.get("/api/v1/analysis/phone/+6281234567890").json()

    assert body["status"] == "ok"
    assert body["data"]["valid"] is True
    assert body["data"]["region"] == "ID"
    # It must not claim carrier knowledge it does not have.
    assert "paid data source" in body["data"]["note"]


def test_phone_invalid_number_is_200_not_an_error(client):
    body = client.get("/api/v1/analysis/phone/+1234").json()
    assert body["status"] == "ok"
    assert body["data"]["valid"] is False


def test_phone_garbage_is_422(client):
    assert client.get("/api/v1/analysis/phone/abc").status_code == 422


def test_phone_is_its_own_endpoint_not_a_scan_field():
    """Phone data must never ride the domain-scan path (TODO)."""
    from app.main import create_app

    paths = {getattr(r, "path", "") for r in create_app().routes} | {
        getattr(getattr(r, "router", None), "prefix", "") for r in create_app().routes
    }
    # Resolve through the app itself rather than trusting route internals, whose
    # shape differs between FastAPI versions (this one wraps included routers).
    schema = create_app().openapi()
    all_paths = set(schema.get("paths", {}))

    assert "/api/v1/analysis/phone/{number}" in all_paths
    # The scan endpoint takes only target/force; no phone field may appear.
    scan_ref = schema["paths"]["/api/v1/scan"]["post"]["requestBody"]["content"][
        "application/json"
    ]["schema"]["$ref"]
    scan_schema = schema["components"]["schemas"][scan_ref.rsplit("/", 1)[-1]]
    assert set(scan_schema["properties"]) == {"target", "force"}
    _ = paths


# --- EXIF -------------------------------------------------------------------


def _png_with_exif_bytes() -> str:
    import base64
    import io

    from PIL import Image

    image = Image.new("RGB", (4, 4), (10, 20, 30))
    exif = image.getexif()
    exif[0x010F] = "TestMake"  # Make
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", exif=exif)
    return base64.b64encode(buffer.getvalue()).decode()


def test_exif_extracts_from_uploaded_bytes(client):
    body = client.post(
        "/api/v1/analysis/exif",
        json={"data": _png_with_exif_bytes(), "filename": "a.png"},
    ).json()

    assert body["status"] == "ok"
    assert body["data"]["ok"] is True
    assert body["data"]["has_exif"] is True


def test_exif_rejects_a_non_image_with_400(client):
    import base64

    response = client.post(
        "/api/v1/analysis/exif",
        json={"data": base64.b64encode(b"not an image").decode()},
    )
    assert response.status_code == 400


def test_exif_type_comes_from_content_not_the_filename(client):
    import base64
    import io

    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", (4, 4)).save(buffer, format="GIF")
    body = client.post(
        "/api/v1/analysis/exif",
        json={
            "data": base64.b64encode(buffer.getvalue()).decode(),
            "filename": "definitely-a-jpeg.jpg",
        },
    ).json()

    assert body["data"]["detected_type"] == "GIF"
    assert body["data"]["extension_mismatch"] is True


def test_exif_rejects_invalid_base64_with_400(client):
    assert (
        client.post(
            "/api/v1/analysis/exif", json={"data": "!!!not base64!!!"}
        ).status_code
        == 400
    )


def test_exif_rejects_oversized_upload_with_413(client, monkeypatch):
    monkeypatch.setattr(analysis_router, "MAX_INPUT_BYTES", 16)
    response = client.post("/api/v1/analysis/exif", json={"data": "A" * 4096})
    assert response.status_code == 413


def _jpeg_with_gps() -> str:
    """A JPEG carrying a real GPSInfo IFD, built with Pillow.

    Written to TIFF rather than PNG because Pillow's PNG writer rejects a
    nested IFD like GPSInfo (the rationals must be flat num/den pairs), which is
    a Pillow encoding constraint rather than anything about EXIF.
    """
    import base64
    import io

    from PIL import Image, TiffImagePlugin

    exif = Image.Exif()
    exif[TiffImagePlugin.ExifTags.Base.Make] = "Canon"
    exif[TiffImagePlugin.ExifTags.Base.Model] = "TestModel"
    # GPSInfo built via get_ifd(), because a nested IFD written as a plain dict
    # key is not the shape Pillow's writer accepts. Coordinates are FLAT
    # num/den triples (51 deg 30' N), which is how EXIF stores them.
    gps = exif.get_ifd(TiffImagePlugin.ExifTags.IFD.GPSInfo)
    gps[1] = "N"
    gps[2] = [51, 1, 30, 1, 0, 1]
    gps[3] = "E"
    gps[4] = [0, 1, 7, 1, 0, 1]

    buffer = io.BytesIO()
    Image.new("RGB", (8, 8), (10, 20, 30)).save(buffer, format="JPEG", exif=exif)
    return base64.b64encode(buffer.getvalue()).decode()


def test_exif_gps_is_present_but_withheld_by_default(client):
    """GPS presence must be reported truthfully while the value stays withheld.

    Withholding the coordinates is the right default (AGENTS.md §7), but
    reporting has_gps=False for a file that does carry them would be a lie that
    lets a user conclude "this photo has no location data".
    """
    body = client.post("/api/v1/analysis/exif", json={"data": _jpeg_with_gps()}).json()

    assert body["data"]["has_gps"] is True
    assert body["data"]["gps"] is None
    assert body["data"]["gps_withheld_reason"]
    # The withheld coordinates must not be hiding in the tag list either.
    assert "-51.5" not in str(body)
    assert "51.5" not in str(body)


# --- rate-limit buckets -----------------------------------------------------


def test_contact_extraction_gets_its_own_bucket(client, monkeypatch):
    """A contact fetch must not be able to exhaust a user's scan allowance."""
    from app.services import contact_service, http_headers_service

    _patch(monkeypatch, contact_service, {"source": "Page contacts", "emails": []})
    _patch(
        monkeypatch, http_headers_service, {"source": "HTTP response", "status": 200}
    )

    # Exhaust the free-quota bucket on the contact scope alone.
    for _ in range(5):
        assert (
            client.post(
                "/api/v1/analysis/contacts", json={"url": "https://a.example"}
            ).status_code
            == 200
        )
    assert (
        client.post(
            "/api/v1/analysis/contacts", json={"url": "https://a.example"}
        ).status_code
        == 429
    )

    # The headers endpoint is unaffected: separate key namespace.
    assert (
        client.post(
            "/api/v1/analysis/headers", json={"url": "https://a.example"}
        ).status_code
        == 200
    )


def test_free_bucket_never_charges_the_instance_daily_scan_budget(client, monkeypatch):
    """check_free_rate_limit must not bill the paid-Shodan cost backstop."""
    from app.services import contact_service

    monkeypatch.setattr(settings, "rate_limit_daily_total", 2)
    _patch(monkeypatch, contact_service, {"source": "Page contacts", "emails": []})

    for index in range(5):
        response = client.post(
            "/api/v1/analysis/contacts", json={"url": f"https://a{index}.example"}
        )
        assert response.status_code == 200, response.text


def test_rate_limit_429_carries_retry_after(client, monkeypatch):
    from app.services import contact_service

    _patch(monkeypatch, contact_service, {"source": "Page contacts", "emails": []})
    for _ in range(5):
        client.post("/api/v1/analysis/contacts", json={"url": "https://a.example"})
    response = client.post(
        "/api/v1/analysis/contacts", json={"url": "https://a.example"}
    )
    assert response.status_code == 429
    assert int(response.headers["Retry-After"]) > 0


# --- cache ------------------------------------------------------------------


def test_a_cache_hit_costs_no_upstream_request(client, monkeypatch):
    from app.services import http_headers_service

    async def _cached(key: str) -> Any:
        if key.startswith("analysis:headers:"):
            return {"source": "HTTP response", "status": 200, "from": "cache"}
        return None

    monkeypatch.setattr(cache_mod, "cache_get_async", _cached)
    calls = _patch(
        monkeypatch, http_headers_service, {"source": "HTTP response", "status": 200}
    )
    body = client.post(
        "/api/v1/analysis/headers", json={"url": "https://example.com"}
    ).json()

    assert calls == [], "a cache hit must not build the job"
    assert body["data"]["from"] == "cache"


def test_force_bypasses_the_cache(client, monkeypatch):
    from app.services import http_headers_service

    async def _cached(key: str) -> Any:
        return {"source": "HTTP response", "status": 200, "from": "cache"}

    monkeypatch.setattr(cache_mod, "cache_get_async", _cached)
    calls = _patch(
        monkeypatch, http_headers_service, {"source": "HTTP response", "status": 200}
    )
    client.post(
        "/api/v1/analysis/headers", json={"url": "https://example.com", "force": True}
    )
    assert len(calls) == 1


def test_tls_and_live_http_use_different_cache_keys(client, monkeypatch):
    """A cert and a redirect chain are different facts; they must not collide."""
    from app.services import http_headers_service, tls_service

    keys: list[str] = []

    async def _record(key: str) -> Any:
        keys.append(key)
        return None

    async def _noop(key: str, value: Any, ttl: int) -> None:
        keys.append(f"set:{key}:{ttl}")

    monkeypatch.setattr(cache_mod, "cache_get_async", _record)
    monkeypatch.setattr(cache_mod, "cache_set_async", _noop)
    _patch(
        monkeypatch, http_headers_service, {"source": "HTTP response", "status": 200}
    )
    _patch(monkeypatch, tls_service, {"source": "TLS", "host": "example.com"})

    client.post("/api/v1/analysis/headers", json={"url": "https://example.com"})
    client.post("/api/v1/analysis/tls", json={"target": "example.com"})

    assert "analysis:headers:https://example.com/" in keys
    assert "analysis:tls:example.com" in keys
    # The live HTTP view must expire far sooner than the certificate view.
    ttls = {k.rsplit(":", 1)[1] for k in keys if k.startswith("set:")}
    assert analysis_router.LIVE_HTTP_CACHE_TTL in {int(t) for t in ttls}
    assert analysis_router.TLS_CACHE_TTL in {int(t) for t in ttls}


# --- capabilities / optional sources ----------------------------------------


def test_capabilities_endpoint_reports_optional_source_state(client, monkeypatch):
    monkeypatch.setattr(settings, "leaklookup_api_key", "")
    monkeypatch.setattr(settings, "virustotal_api_key", "")

    body = client.get("/api/v1/analysis/capabilities").json()
    assert body["optional_sources"]["leaklookup"] is False
    assert body["optional_sources"]["urlscan"] is True
    assert body["optional_sources"]["virustotal"] is False
    # OTX serves several endpoints with no key, so it is usable rather than off.
    assert body["optional_sources"]["otx"] is True
    assert "headers" in body["always_available"]


def test_a_configured_key_marks_virustotal_available(client, monkeypatch):
    monkeypatch.setattr(settings, "virustotal_api_key", "a-vt-key")
    assert (
        client.get("/api/v1/analysis/capabilities").json()["optional_sources"][
            "virustotal"
        ]
        is True
    )
