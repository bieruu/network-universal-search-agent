"""Shared pytest fixtures for the backend suite.

Only one fixture lives here, and it is the seam the DNS scan-source needs.

`dns_service.lookup` is a real network call: `dns.asyncresolver` reads the
system resolver and asks the target's authoritative nameservers directly. A
unit-test suite that lets that run is slow, flaky, and quietly bills the
machine it runs on, so the orchestrator's reference to the module is replaced
with a stub for every test in the repo.

The stub is swapped in on the ORCHESTRATOR's module attribute, not on
`dns_service` itself. That is deliberate:

  * `test_dns_service.py` keeps the real resolver path — it injects a fake
    resolver object and never touches the network, and it must stay able to.
  * The analysis-router tests keep the real module, because they patch
    `dns_service.lookup` themselves to assert router behaviour.

A test that wants a specific DNS outcome on the scan path replaces the stub
with its own (a later `monkeypatch.setattr(orchestrator, "dns_service", ...)`
wins over this fixture, and monkeypatch unwinds in reverse order).
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest

from app.schemas.dns import DnsLookupResult
from app.services import orchestrator


def _stub_dns_payload(target: str) -> dict[str, Any]:
    """A minimal, schema-valid DNS block that echoes the target.

    Built through the real response model so the stub can never drift out of
    the shape the scan response model documents.
    """
    return DnsLookupResult(
        domain=target.lower().rstrip("."),
        records={"A": [{"value": "93.184.216.34", "ttl": 300}]},
    ).model_dump()


class _StubDnsService:
    """Module-shaped stand-in: `orchestrator` only ever calls `.lookup`."""

    def __init__(self) -> None:
        self.calls: list[str] = []

    async def lookup(
        self, target: str, resolver: Any = None, **kwargs: Any
    ) -> dict[str, Any]:
        self.calls.append(target)
        return _stub_dns_payload(target)


@pytest.fixture(autouse=True)
def stub_orchestrator_dns(monkeypatch: pytest.MonkeyPatch) -> Iterator[_StubDnsService]:
    stub = _StubDnsService()
    monkeypatch.setattr(orchestrator, "dns_service", stub)
    yield stub
