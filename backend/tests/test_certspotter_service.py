from __future__ import annotations

import httpx
import pytest

from app.services import certspotter_service


class _Response:
    def __init__(self, body, status_code=200):
        self._body = body
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            request = httpx.Request("GET", "https://api.certspotter.com/v1/issuances")
            response = httpx.Response(self.status_code, request=request)
            raise httpx.HTTPStatusError(
                f"HTTP {self.status_code}", request=request, response=response
            )

    def json(self):
        return self._body


class _Client:
    def __init__(self, response):
        self.response = response
        self.call = None

    async def get(self, url, **kwargs):
        self.call = (url, kwargs)
        return self.response


@pytest.mark.asyncio
async def test_certspotter_normalizes_and_filters_certificate_names():
    client = _Client(
        _Response(
            [
                {
                    "dns_names": [
                        "EXAMPLE.COM",
                        "*.WWW.Example.com.",
                        "www.example.com",
                        "example.com.attacker.test",
                        "invalid name.example.com",
                    ],
                    "not_before": "2025-01-01T00:00:00Z",
                    "not_after": "2026-01-01T00:00:00Z",
                }
            ]
        )
    )

    result = await certspotter_service.lookup("Example.com", client)

    assert result == {
        "domain": "example.com",
        "source": "Cert Spotter",
        "count": 2,
        "subdomains": [
            {
                "subdomain": "example.com",
                "issuer": "",
                "not_before": "2025-01-01T00:00:00Z",
                "not_after": "2026-01-01T00:00:00Z",
            },
            {
                "subdomain": "www.example.com",
                "issuer": "",
                "not_before": "2025-01-01T00:00:00Z",
                "not_after": "2026-01-01T00:00:00Z",
            },
        ],
    }
    url, kwargs = client.call
    assert url == "https://api.certspotter.com/v1/issuances"
    assert kwargs["params"] == {
        "domain": "example.com",
        "include_subdomains": "true",
        "match_wildcards": "true",
        "expand": "dns_names",
    }
    assert kwargs["timeout"] == certspotter_service._TIMEOUT_SECONDS


@pytest.mark.asyncio
async def test_certspotter_rejects_malformed_response():
    with pytest.raises(TypeError, match="invalid response"):
        await certspotter_service.lookup("example.com", _Client(_Response({})))


@pytest.mark.asyncio
async def test_certspotter_surfaces_http_errors():
    with pytest.raises(httpx.HTTPStatusError):
        await certspotter_service.lookup(
            "example.com", _Client(_Response({}, status_code=429))
        )
