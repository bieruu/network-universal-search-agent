"""Tests for dns_service.

Nothing here touches the network. A fake resolver is injected and every
assertion is made against the service's own output, so these tests are bound to
this module's contract rather than to dnspython's internal classes.
"""

from __future__ import annotations

import json
from typing import Any

import dns.asyncresolver
import dns.resolver
import pytest
from dns.exception import DNSException, Timeout
from dns.resolver import NXDOMAIN, NoAnswer, NoNameservers

from app.core.config import settings
from app.services import dns_service


class _Rdata:
    """Stand-in for a dnspython rdata object.

    The service only asks `str(rdata)` and reads `.ttl` plus the MX/SOA field
    names, so plain objects exercise the real code path without pinning these
    tests to dnspython's constructors.
    """

    def __init__(self, text: str, ttl: int = 300, **fields: Any) -> None:
        self.text = text
        self.ttl = ttl
        for name, value in fields.items():
            setattr(self, name, value)

    def __str__(self) -> str:
        return self.text


class _Rrset:
    """Stand-in for an rrset: the nested shape a real dnspython answer yields."""

    def __init__(self, rdtype: str, ttl: int, rdatas: list[_Rdata]) -> None:
        self.rdtype = rdtype
        self.ttl = ttl
        self._rdatas = rdatas

    def __iter__(self):
        return iter(self._rdatas)


class _Resolver:
    """Answers from a canned per-type table and records what it was asked.

    A type mapped to an exception is raised instead of answered, which is how
    the isolation tests inject a timeout or an NXDOMAIN. Any type left out of
    the table gets NoAnswer, so an unlisted type behaves the way real DNS does
    for a name that simply publishes nothing.
    """

    def __init__(self, table: dict[str, Any]) -> None:
        self.table = table
        self.calls: list[tuple[str, str]] = []
        self.lifetime: float | None = None
        self.timeout: float | None = None

    async def resolve(self, name: str, rdtype: str, *args: Any, **kwargs: Any) -> Any:
        self.calls.append((name, rdtype))
        outcome = self.table.get(rdtype, NoAnswer())
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome


def _mx_row(preference: int) -> _Rdata:
    exchange = f"mail{preference}.example.com."
    return _Rdata(f"{preference} {exchange}", exchange=exchange, preference=preference)


def _full_table() -> dict[str, Any]:
    """One populated entry for every queried record type."""
    return {
        "A": [_Rrset("A", 300, [_Rdata("93.184.216.34"), _Rdata("93.184.216.35")])],
        "AAAA": [_Rrset("AAAA", 300, [_Rdata("2606:2800:220:1:248:1893:25c8:1946")])],
        "MX": [_Rrset("MX", 3600, [_mx_row(20), _mx_row(10)])],
        "NS": [
            _Rrset(
                "NS", 172800, [_Rdata("ns1.example.com."), _Rdata("ns2.example.com.")]
            )
        ],
        "TXT": [_Rrset("TXT", 300, [_Rdata('"v=spf1 include:_spf.example.com ~all"')])],
        "CNAME": [_Rrset("CNAME", 60, [_Rdata("cdn.example.net.")])],
        "SOA": [
            _Rrset(
                "SOA",
                900,
                [
                    _Rdata(
                        "ns1.example.com. admin.example.com. 2024010101 7200 3600 "
                        "1209600 300",
                        mname="ns1.example.com.",
                        rname="admin.example.com.",
                        serial=2024010101,
                        refresh=7200,
                        retry=3600,
                        expire=1209600,
                        minimum=300,
                    )
                ],
            )
        ],
    }


async def test_lookup_parses_all_seven_record_types():
    resolver = _Resolver(_full_table())

    result = await dns_service.lookup("example.com", resolver)

    assert result["source"] == "DNS"
    assert result["domain"] == "example.com"
    assert list(result["records"]) == ["A", "AAAA", "MX", "NS", "TXT", "CNAME", "SOA"]
    assert result["records"]["A"] == [
        {"value": "93.184.216.34", "ttl": 300},
        {"value": "93.184.216.35", "ttl": 300},
    ]
    assert result["records"]["AAAA"] == [
        {"value": "2606:2800:220:1:248:1893:25c8:1946", "ttl": 300}
    ]
    assert result["records"]["NS"] == [
        {"value": "ns1.example.com.", "ttl": 172800},
        {"value": "ns2.example.com.", "ttl": 172800},
    ]
    assert result["records"]["CNAME"] == [{"value": "cdn.example.net.", "ttl": 60}]
    assert result["records"]["TXT"] == [
        {
            "value": '"v=spf1 include:_spf.example.com ~all"',
            "ttl": 300,
            "truncated": False,
        }
    ]
    assert result["missing"] == []
    assert result["errors"] == []
    assert result["counts_truncated"] is False
    assert result["note"] == ""
    # Each type is asked exactly once, for the normalized name.
    assert resolver.calls == [
        ("example.com", rdtype) for rdtype in dns_service.RECORD_TYPES
    ]


async def test_lookup_accepts_a_flat_rdata_answer_without_rrsets():
    """dnspython nests rdata inside rrsets; a supplied resolver may not."""
    resolver = _Resolver({"A": [_Rdata("198.51.100.7", ttl=120)]})

    result = await dns_service.lookup("example.com", resolver)

    assert result["records"]["A"] == [{"value": "198.51.100.7", "ttl": 120}]


async def test_mx_preference_is_captured_and_ordered():
    resolver = _Resolver(
        {"MX": [_Rrset("MX", 3600, [_mx_row(30), _mx_row(10), _mx_row(20)])]}
    )

    result = await dns_service.lookup("example.com", resolver)

    assert result["records"]["MX"] == [
        {"value": "mail10.example.com.", "preference": 10, "ttl": 3600},
        {"value": "mail20.example.com.", "preference": 20, "ttl": 3600},
        {"value": "mail30.example.com.", "preference": 30, "ttl": 3600},
    ]
    # `value` is the exchanger alone; the preference is not repeated inside it.
    assert "10 mail" not in result["records"]["MX"][0]["value"]


async def test_soa_fields_are_captured():
    resolver = _Resolver(_full_table())

    result = await dns_service.lookup("example.com", resolver)

    assert result["records"]["SOA"] == [
        {
            "mname": "ns1.example.com.",
            "rname": "admin.example.com.",
            "serial": 2024010101,
            "refresh": 7200,
            "retry": 3600,
            "expire": 1209600,
            "minimum": 300,
            "ttl": 900,
        }
    ]


async def test_long_txt_blob_is_truncated_to_512_and_flagged():
    """SPF/DKIM/DMARC blobs run to kilobytes; a scan response must stay a summary."""
    blob = '"' + ("v=spf1 include:_spf.very.long.example.net " * 300) + '"'
    assert len(blob) > 6000
    resolver = _Resolver(
        {
            "TXT": [
                _Rrset(
                    "TXT",
                    300,
                    [_Rdata(blob), _Rdata('"short-and-whole"')],
                )
            ]
        }
    )

    result = await dns_service.lookup("example.com", resolver)

    txt = result["records"]["TXT"]
    assert len(txt) == 2
    assert len(txt[0]["value"]) == 512
    assert txt[0]["truncated"] is True
    assert txt[1] == {"value": '"short-and-whole"', "ttl": 300, "truncated": False}
    assert "TXT" in result["note"]
    assert "512" in result["note"]


async def test_record_counts_are_capped_at_fifty_per_type():
    resolver = _Resolver(
        {"A": [_Rrset("A", 60, [_Rdata(f"198.51.100.{i}") for i in range(120)])]}
    )

    result = await dns_service.lookup("example.com", resolver)

    assert len(result["records"]["A"]) == 50
    assert result["records"]["A"][0]["value"] == "198.51.100.0"
    assert result["records"]["A"][-1]["value"] == "198.51.100.49"
    assert result["counts_truncated"] is True
    assert "50" in result["note"]


async def test_one_timing_out_type_keeps_the_other_six():
    resolver = _Resolver({**_full_table(), "MX": Timeout("query timed out")})

    result = await dns_service.lookup("example.com", resolver)

    assert result["records"]["MX"] == []
    assert result["errors"] == [{"type": "MX", "message": "query timed out"}]
    for rdtype in ("A", "AAAA", "NS", "TXT", "CNAME", "SOA"):
        assert result["records"][rdtype], f"{rdtype} was lost"
    assert result["counts_truncated"] is False
    assert "MX" in result["note"]


async def test_servfail_and_timeout_across_types_are_all_reported():
    resolver = _Resolver(
        {
            "A": NoNameservers("SERVFAIL: no nameservers answered"),
            "MX": Timeout("timed out"),
            "TXT": DNSException("malformed rdata"),
        }
    )

    result = await dns_service.lookup("example.com", resolver)

    assert [error["type"] for error in result["errors"]] == ["A", "MX", "TXT"]
    assert result["errors"][0]["message"] == "SERVFAIL: no nameservers answered"
    assert result["errors"][2]["message"] == "malformed rdata"
    # Types left out of the table answer NoAnswer, which is missing, not an error.
    assert result["missing"] == ["AAAA", "NS", "CNAME", "SOA"]
    # A failed type is not also reported as missing: it is unknown, not absent.
    assert "A" not in result["missing"]
    assert "partial evidence" in result["note"]


async def test_error_messages_are_bounded():
    """A hostile authoritative server can shape DNSException text, so it is cut."""
    resolver = _Resolver({"A": DNSException("x" * 5000)})

    result = await dns_service.lookup("example.com", resolver)

    assert len(result["errors"][0]["message"]) == dns_service.MAX_ERROR_CHARS


async def test_values_are_bounded_for_every_record_type():
    """No real record carries this much text, which is precisely why the cut is
    asserted against a hostile answer rather than against plausible input."""
    resolver = _Resolver({"NS": [_Rdata("n" * 5000)]})

    result = await dns_service.lookup("example.com", resolver)

    assert len(result["records"]["NS"][0]["value"]) == dns_service.MAX_VALUE_CHARS


async def test_nxdomain_for_the_domain_reports_that_it_does_not_resolve():
    resolver = _Resolver({rdtype: NXDOMAIN() for rdtype in dns_service.RECORD_TYPES})

    result = await dns_service.lookup("nope.example", resolver)

    assert result["domain"] == "nope.example"
    assert all(rows == [] for rows in result["records"].values())
    assert result["missing"] == list(dns_service.RECORD_TYPES)
    assert result["errors"] == []
    assert "does not resolve" in result["note"]
    assert "NXDOMAIN" in result["note"]


async def test_empty_answer_is_distinguished_from_nxdomain():
    """The name exists and these types are simply unset. That is not NXDOMAIN."""
    table = _full_table()
    table["AAAA"] = NoAnswer()
    table["CNAME"] = NoAnswer()
    resolver = _Resolver(table)

    result = await dns_service.lookup("example.com", resolver)

    assert result["missing"] == ["AAAA", "CNAME"]
    assert "No records published for AAAA, CNAME" in result["note"]
    assert "NXDOMAIN" not in result["note"]
    assert result["records"]["A"], "the other five types still answered"


async def test_partial_nxdomain_is_named_without_claiming_the_domain_is_gone():
    resolver = _Resolver({**_full_table(), "AAAA": NXDOMAIN()})

    result = await dns_service.lookup("example.com", resolver)

    assert result["missing"] == ["AAAA"]
    assert "NXDOMAIN" in result["note"]
    assert "AAAA" in result["note"]
    assert "does not resolve" not in result["note"]


@pytest.mark.parametrize(
    "target", ["8.8.8.8", "::1", "2001:db8::1", "127.0.0.1", "169.254.169.254"]
)
async def test_ip_literal_target_is_rejected(target):
    """DNS records are meaningless for an address, and an empty-but-successful
    result would read as "this host publishes no MX records"."""
    resolver = _Resolver(_full_table())

    with pytest.raises(ValueError, match="not an IP address"):
        await dns_service.lookup(target, resolver)

    assert resolver.calls == [], "an IP literal must not reach the resolver"


@pytest.mark.parametrize(
    "target", ["", "   ", "example", "not a domain", "exa mple.com", "-bad.com", ".com"]
)
async def test_malformed_hostname_is_rejected(target):
    with pytest.raises(ValueError, match="valid DNS domain"):
        await dns_service.lookup(target, _Resolver(_full_table()))


async def test_trailing_dot_and_uppercase_are_normalized():
    resolver = _Resolver(_full_table())

    result = await dns_service.lookup("  ExAmPlE.CoM.  ", resolver)

    assert result["domain"] == "example.com"
    assert {name for name, _rdtype in resolver.calls} == {"example.com"}


async def test_lookup_never_touches_the_blocking_resolver(monkeypatch):
    """The sync resolver would stall the whole event loop (AGENTS.md §3), so it
    must never appear in this module. Patching it to explode makes an accidental
    use loud instead of invisible during a test run."""
    assert not issubclass(
        dns.asyncresolver.Resolver, dns.resolver.Resolver
    ), "this guard only means something while the async resolver is not a subclass"

    def _boom(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("the blocking resolver was called from async code")

    monkeypatch.setattr(dns.resolver.Resolver, "resolve", _boom)

    result = await dns_service.lookup("example.com", _Resolver(_full_table()))

    assert result["records"]["A"]


async def test_a_bug_in_the_caller_resolver_is_not_reported_as_partial():
    """Only DNSException means partial. A broken resolver must be loud, or a
    defect in this module would ship as silently empty DNS results."""

    class _Exploding:
        async def resolve(self, *args: Any, **kwargs: Any) -> Any:
            raise TypeError("resolver called wrong")

    with pytest.raises(TypeError, match="resolver called wrong"):
        await dns_service.lookup("example.com", _Exploding())


async def test_built_resolver_is_explicitly_bounded():
    """The bound must be this repo's decision, not dnspython's 5s/2s default."""
    seconds = dns_service._timeout_seconds()

    resolver = dns_service._build_resolver(seconds)

    assert isinstance(resolver, dns.asyncresolver.Resolver)
    assert resolver.lifetime == seconds
    assert resolver.timeout == seconds
    # Today the whois budget is the fallback; a scan_timeout_dns field supersedes it.
    assert seconds == float(settings.scan_timeout_whois)


async def test_timeout_knob_is_read_from_settings(monkeypatch):
    """A dedicated scan_timeout_dns field, once it lands on Settings, must take
    effect without a code change here."""
    monkeypatch.setattr(
        dns_service,
        "settings",
        type(
            "_Settings",
            (),
            {"scan_timeout_dns": 7, "scan_timeout_whois": 10},
        ),
    )

    assert dns_service._timeout_seconds() == 7.0
    assert dns_service._build_resolver(dns_service._timeout_seconds()).lifetime == 7.0


async def test_result_is_json_serialisable():
    resolver = _Resolver(
        {
            **_full_table(),
            "MX": Timeout("x" * 5000),
            "TXT": [_Rdata('"' + "y" * 6000 + '"')],
            "A": [_Rdata(f"198.51.100.{i}") for i in range(120)],
        }
    )

    result = await dns_service.lookup("example.com", resolver)

    assert json.loads(json.dumps(result)) == result
