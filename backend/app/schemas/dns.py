"""Pydantic v2 models for a parsed DNS lookup (the scan path's fifth source).

WHY THE MODEL EXISTS
--------------------
A DNS answer is chosen by whoever runs the target's authoritative nameserver,
so it is untrusted input (AGENTS.md §5.4) exactly like a Shodan banner or a
crt.sh row. `dns_service` already bounds every field — values cut, counts
capped, TXT cut harder — but this module is where the *shape* of a lookup is
declared instead of being implied by however the dicts happened to be built.

Two rules keep the model from becoming the trust it exists to avoid:

  * Every field is bounded and defaults to an empty value, so a resolver that
    omits something cannot push the model into a state that reads as a finding.
  * Construction happens at the end of `dns_service.lookup`, after the
    service's own truncation. The model is a description of what was already
    made safe, not the thing that makes it safe.

`records` is declared per record type rather than as one loose row model: MX,
TXT and SOA genuinely carry different fields, and a union with optional
everything would let an MX row silently lose its preference or an SOA row
mint a meaningless `value`. Field order on `DnsRecords` is the order the types
are queried in, which is the order the service already answers them in.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class DnsSimpleRecord(BaseModel):
    """A / AAAA / NS / CNAME: one opaque value plus the rrset TTL."""

    value: str
    ttl: int = 0


class DnsMxRecord(DnsSimpleRecord):
    """MX: the mail exchanger, with the preference captured separately.

    `value` is the exchanger alone; str(rdata) on an MX record would repeat
    the preference inside the value, and a reader cannot tell that apart
    from a hostname that starts with a number.
    """

    preference: int = 0


class DnsTxtRecord(DnsSimpleRecord):
    """TXT, cut hard.

    `truncated` is the whole point: an SPF/DKIM/DMARC blob is routinely
    kilobytes, and half of one must never be readable as the whole record.
    """

    truncated: bool = False


class DnsSoaRecord(BaseModel):
    """SOA: every field, so the zone's serial and timers are readable.

    Deliberately not a subclass of DnsSimpleRecord: an SOA record has no
    single "value", and giving it one would invent a field the wire format
    does not have.
    """

    mname: str = ""
    rname: str = ""
    serial: int = 0
    refresh: int = 0
    retry: int = 0
    expire: int = 0
    minimum: int = 0
    ttl: int = 0


class DnsTypeError(BaseModel):
    """One record type that could not be queried.

    A failed type is *unknown*, not absent: the note and this list have to be
    able to say "we asked and got nothing back" without that reading as
    "this name publishes nothing".
    """

    type: str
    message: str


class DnsRecords(BaseModel):
    """The seven queried record types.

    Declaration order is the response order, which is the order
    `dns_service.RECORD_TYPES` queries them in. A type the caller never heard
    of is ignored rather than rejected: the shape of a response must not
    become a second validation layer over already-bounded data.
    """

    A: list[DnsSimpleRecord] = []
    AAAA: list[DnsSimpleRecord] = []
    MX: list[DnsMxRecord] = []
    NS: list[DnsSimpleRecord] = []
    TXT: list[DnsTxtRecord] = []
    CNAME: list[DnsSimpleRecord] = []
    SOA: list[DnsSoaRecord] = []


class DnsLookupResult(BaseModel):
    """One parsed DNS lookup, ready to be stored in a scan snapshot.

    `missing` distinguishes NXDOMAIN ("the name does not exist") from an empty
    NOERROR answer ("the name exists, this type is unset") from a failed query
    ("we asked and got nothing back"), because those three lead to opposite
    conclusions and `note` states which was which.
    """

    source: str = "DNS"
    domain: str = Field(max_length=253)
    records: DnsRecords = Field(default_factory=DnsRecords)
    counts_truncated: bool = False
    missing: list[str] = []
    errors: list[DnsTypeError] = []
    note: str = ""
