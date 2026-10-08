"""One scan, one DNS resolution (TODO: residual security review 2026-10-07).

POST /scan resolves the target twice today: the router pre-flight has to, to
answer a name pointing at a blocked IP with a 400 instead of a silent partial
result, and shodan_service.lookup resolves it again for the Shodan request. The
pre-flight answer is now threaded router -> orchestrator -> service, so the
tests here pin that count.

Nothing real is touched: the resolve seam is counted at
app.core.security._sync_resolve (the blocking body every resolve_target_ip hands
to a thread), the orchestrator's `httpx` module reference is swapped for a
recording fake, and crt.sh/WHOIS/cache/DB are stubbed.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import HTTPException

from app.core import security
from app.core.config import settings
from app.services import orchestrator, shodan_service

SHODAN_HOST = {
    "ports": [80, 443],
    "data": [
        {
            "port": 80,
            "transport": "tcp",
            "product": "nginx",
            "version": "1.25",
            "data": "server: nginx",
        }
    ],
    "vulns": {},
    "isp": "Example ISP",
    "asn": "AS1234",
    "city": "Jakarta",
    "country_name": "Indonesia",
}
PUBLIC_IP = "93.184.216.34"


class _FakeResponse:
    status_code = 200

    def raise_for_status(self):
        return None

    def json(self):
        return dict(SHODAN_HOST)


class _RecordingClient:
    """httpx.AsyncClient stand-in. Records every URL it is asked for."""

    def __init__(self):
        self.urls: list[str] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc_info):
        return False

    async def get(self, url, params=None, timeout=None):
        self.urls.append(url)
        return _FakeResponse()


class _FakeHttpx:
    """Stand-in for the `httpx` module gather_results builds its client from.

    Swapped in as the orchestrator's own module reference, so the real httpx —
    and the one shodan_service imports for its exception types — is untouched.
    """

    def __init__(self, client):
        self._client = client

    def Limits(self, **kwargs):
        return kwargs

    def AsyncClient(self, **kwargs):
        return self._client


class _Dns:
    """The single resolve seam, counting every lookup made during a test."""

    def __init__(self):
        self.hosts: list[str] = []
        self.ip = PUBLIC_IP
        self.error: str | None = None

    def __call__(self, host: str) -> str:
        self.hosts.append(host)
        if self.error is not None:
            raise OSError(self.error)
        return self.ip

    @property
    def count(self) -> int:
        return len(self.hosts)


@pytest.fixture
def dns(monkeypatch):
    spy = _Dns()
    monkeypatch.setattr(security, "_sync_resolve", spy)
    return spy


@pytest.fixture
def shodan_key(monkeypatch):
    monkeypatch.setattr(settings, "shodan_api_key", "test-key")
    return "test-key"


async def _no_cache_get(key: str):
    return None


async def _no_cache_set(*args, **kwargs):
    return None


@pytest.fixture
def scan_client(monkeypatch):
    """POST /scan with auth + DB stubbed; the rate-limit bucket is reset."""
    from fastapi.testclient import TestClient

    from app.core import rate_limit
    from app.core.security import require_user
    from app.db.session import get_session
    from app.main import create_app

    monkeypatch.setattr(settings, "rate_limit_per_hour", 100)
    rate_limit.reset_for_tests()
    app = create_app()
    app.dependency_overrides[require_user] = lambda: "user:test"
    app.dependency_overrides[get_session] = lambda: None
    with TestClient(app) as client:
        yield client
    rate_limit.reset_for_tests()


class _Chain:
    def __init__(self, client, persisted):
        self.client = client
        self.persisted = persisted

    @property
    def payload(self) -> dict:
        return self.persisted["payload"]

    @property
    def errors(self) -> list[dict]:
        return self.payload["errors"]


@pytest.fixture
def chain(monkeypatch, shodan_key):
    """POST /scan through the real orchestrator and the real shodan lookup.

    Only crt.sh, WHOIS, the cache and the DB write are faked — none of them are
    what this path is about. shodan_service.lookup stays real so its DNS
    behaviour is what actually gets measured.
    """
    from app.routers import scan as scan_router

    client = _RecordingClient()
    monkeypatch.setattr(orchestrator, "httpx", _FakeHttpx(client))

    async def _ok_crtsh(target, client=None):
        return {"domain": target, "count": 0, "subdomains": []}

    async def _ok_whois(target):
        return {
            "domain": target,
            "registrar": "Example Registrar",
            "emails": "redacted",
        }

    monkeypatch.setattr(orchestrator.crtsh_service, "lookup", _ok_crtsh)
    monkeypatch.setattr(orchestrator.whois_service, "lookup", _ok_whois)
    monkeypatch.setattr(orchestrator.cache_mod, "cache_get_async", _no_cache_get)
    monkeypatch.setattr(orchestrator.cache_mod, "cache_set_async", _no_cache_set)

    persisted: dict = {}

    async def _record(**kwargs):
        persisted.update(kwargs)

    monkeypatch.setattr(scan_router, "_persist", _record)
    return _Chain(client, persisted)


# --- the single resolution ------------------------------------------------


def test_scan_resolves_a_hostname_exactly_once(scan_client, chain, dns):
    response = scan_client.post("/api/v1/scan", json={"target": "example.com"})

    assert response.status_code == 200
    assert dns.hosts == ["example.com"], "a scan must cost exactly one DNS query"
    # The handed-down IP is what reaches Shodan, not a second resolution.
    assert chain.client.urls == [f"https://api.shodan.io/shodan/host/{PUBLIC_IP}"]
    assert chain.payload["status"] == "completed"
    assert chain.errors == []
    assert chain.payload["results"]["shodan"]["ip"] == PUBLIC_IP


def test_scan_of_an_ip_literal_queries_dns_zero_times(scan_client, chain, dns):
    response = scan_client.post("/api/v1/scan", json={"target": PUBLIC_IP})

    assert response.status_code == 200
    assert dns.count == 0
    assert chain.client.urls == [f"https://api.shodan.io/shodan/host/{PUBLIC_IP}"]
    assert chain.payload["results"]["shodan"]["ip"] == PUBLIC_IP


# --- the 400 must still reach the client -----------------------------------


@pytest.mark.parametrize("blocked_ip", ["127.0.0.1", "169.254.169.254", "10.0.0.5"])
def test_blocked_resolved_ip_is_400_and_shodan_is_never_contacted(
    scan_client, chain, dns, blocked_ip
):
    # The name passes the cheap string check, so only the resolution catches it.
    # That check has to stay in the router: the orchestrator would fold its 400
    # into errors[] and answer 200 with a partial scan.
    dns.ip = blocked_ip

    response = scan_client.post("/api/v1/scan", json={"target": "internal.example.com"})

    assert response.status_code == 400
    assert response.json()["detail"] == "Private/localhost targets are blocked"
    assert chain.client.urls == []
    assert chain.persisted == {}  # never reached the fan-out
    assert dns.count == 1  # pre-flight only; the 400 stops the request there


# --- shodan_service.lookup on its own --------------------------------------


@pytest.mark.asyncio
async def test_lookup_without_a_preresolved_ip_resolves_itself(shodan_key, dns):
    client = _RecordingClient()

    out = await shodan_service.lookup("example.com", client=client)

    assert dns.hosts == ["example.com"]
    assert out["ip"] == PUBLIC_IP
    assert client.urls == [f"https://api.shodan.io/shodan/host/{PUBLIC_IP}"]


@pytest.mark.asyncio
async def test_lookup_without_a_preresolved_ip_still_blocks_a_private_result(
    shodan_key, dns
):
    dns.ip = "169.254.169.254"
    client = _RecordingClient()

    with pytest.raises(HTTPException) as err:
        await shodan_service.lookup("internal.example.com", client=client)

    assert err.value.status_code == 400
    assert client.urls == []
    assert dns.count == 1


@pytest.mark.asyncio
async def test_lookup_of_an_ip_literal_resolves_nothing(shodan_key, dns):
    client = _RecordingClient()

    out = await shodan_service.lookup(PUBLIC_IP, client=client)

    assert dns.count == 0
    assert out["ip"] == PUBLIC_IP


@pytest.mark.asyncio
async def test_lookup_validates_a_handed_down_ip_it_never_resolved(shodan_key, dns):
    # A resolved_ip is only as trustworthy as its caller, and the service is the
    # last gate before an outbound request: a blocked one costs zero requests.
    for blocked in ("127.0.0.1", "169.254.169.254", "10.0.0.5"):
        client = _RecordingClient()
        with pytest.raises(HTTPException) as err:
            await shodan_service.lookup(
                "example.com", client=client, resolved_ip=blocked
            )
        assert err.value.status_code == 400
        assert client.urls == []
    assert dns.count == 0


@pytest.mark.asyncio
async def test_lookup_uses_a_handed_down_ip_without_resolving(shodan_key, dns):
    client = _RecordingClient()

    out = await shodan_service.lookup(
        "example.com", client=client, resolved_ip="1.1.1.1"
    )

    assert dns.count == 0
    assert out["ip"] == "1.1.1.1"
    assert client.urls == ["https://api.shodan.io/shodan/host/1.1.1.1"]


@pytest.mark.asyncio
async def test_lookup_falls_back_to_resolving_an_unusable_handed_down_ip(
    shodan_key, dns
):
    # A value that is not an IP is never forwarded to Shodan as-is.
    client = _RecordingClient()

    out = await shodan_service.lookup("example.com", client=client, resolved_ip="nope")

    assert dns.hosts == ["example.com"]
    assert out["ip"] == PUBLIC_IP
    assert client.urls == [f"https://api.shodan.io/shodan/host/{PUBLIC_IP}"]


# --- pre-flight failure: partial result, never a 500 -----------------------


def test_preflight_dns_failure_is_a_partial_result_not_a_500(scan_client, chain, dns):
    dns.error = "Name or service not known"

    response = scan_client.post("/api/v1/scan", json={"target": "nonexistent.invalid"})

    assert response.status_code == 200
    assert chain.payload["status"] == "partial"
    assert "crtsh" in chain.payload["results"]
    assert "whois" in chain.payload["results"]
    shodan_errors = [e for e in chain.errors if e["source"] == "shodan"]
    assert len(shodan_errors) == 1
    assert "DNS resolve failed" in shodan_errors[0]["message"]
    assert chain.client.urls == []
    # Two attempts by design: the pre-flight hands down None on failure, so the
    # source resolves for itself and a one-off resolver blip is not made
    # permanent by us.
    assert dns.hosts == ["nonexistent.invalid", "nonexistent.invalid"]


# --- cache hits ------------------------------------------------------------


def test_shodan_cache_hit_sends_no_request_and_needs_no_service_dns(
    scan_client, chain, dns, monkeypatch
):
    cached = {
        "source": "Shodan",
        "ip": PUBLIC_IP,
        "ports": [443],
        "services": [],
        "vulns": [],
        "cpes": [],
        "isp": "Example ISP",
        "asn": "AS1234",
        "city": "Jakarta",
        "country_name": "Indonesia",
    }

    async def _cache_get(key: str):
        # Cache keys stay keyed by target string, not by IP.
        return cached if key == "shodan:example.com" else None

    monkeypatch.setattr(orchestrator.cache_mod, "cache_get_async", _cache_get)

    response = scan_client.post("/api/v1/scan", json={"target": "example.com"})

    assert response.status_code == 200
    assert chain.client.urls == []
    assert chain.payload["status"] == "completed"
    assert chain.errors == []
    assert chain.payload["results"]["shodan"]["ports"] == [443]
    # Only the pre-flight paid for DNS; the cache hit never built the job.
    assert dns.hosts == ["example.com"]


# --- the pre-flight helper's own contract ----------------------------------


@pytest.mark.asyncio
async def test_preflight_returns_the_resolved_ip_for_a_hostname(dns):
    assert await security.assert_resolved_target_allowed("example.com") == PUBLIC_IP
    assert dns.count == 1


@pytest.mark.asyncio
async def test_preflight_returns_none_when_the_name_does_not_resolve(dns):
    dns.error = "no such host"
    assert await security.assert_resolved_target_allowed("nonexistent.invalid") is None
    assert dns.count == 1


@pytest.mark.asyncio
async def test_preflight_returns_none_for_an_ip_literal(dns):
    assert await security.assert_resolved_target_allowed(PUBLIC_IP) is None
    assert dns.count == 0


@pytest.mark.asyncio
async def test_preflight_still_400s_on_a_blocked_resolution(dns):
    dns.ip = "127.0.0.1"
    with pytest.raises(HTTPException) as err:
        await security.assert_resolved_target_allowed("internal.example.com")
    assert err.value.status_code == 400
    assert err.value.detail == "Private/localhost targets are blocked"


# --- no second resolver anywhere in the backend ---------------------------


def test_only_one_resolver_exists_in_the_backend():
    # The whole fix assumes there is exactly one place that turns a hostname into
    # an IP. A stray getaddrinfo in a new service would reintroduce both the
    # duplicate lookup and a sync call on the event loop (AGENTS.md §3).
    #
    # Two files are exempt, and neither weakens the scan-path guarantee:
    #   - security.py — the seam itself.
    #   - core/ssrf.py — the target-fetch guard, which is a different subsystem
    #     with a different job. It resolves once per *fetch hop*, on purpose,
    #     because it must re-check every address a redirect target answers with.
    #     It must use getaddrinfo rather than gethostbyname because the latter is
    #     IPv4-only and would hide an AAAA record pointing at loopback. It never
    #     feeds the scan path, so it cannot cause a duplicate scan lookup.
    app_dir = Path(__file__).resolve().parents[1] / "app"
    exempt = {"security.py", "ssrf.py"}
    offenders = [
        path.relative_to(app_dir.parent).as_posix()
        for path in sorted(app_dir.rglob("*.py"))
        if path.name not in exempt
        and any(
            token in path.read_text(encoding="utf-8")
            for token in ("gethostbyname", "getaddrinfo", "gethostbyname_ex")
        )
    ]
    assert offenders == []


def test_resolve_target_ip_is_the_only_caller_of_the_seam():
    import inspect

    src = inspect.getsource(security.resolve_target_ip)
    assert "_sync_resolve" in src
    assert "to_thread" in src  # AGENTS.md §3: no sync I/O on the event loop
    assert inspect.getsource(security._sync_resolve).count("gethostbyname") == 1
