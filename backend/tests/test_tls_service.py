"""Tests for tls_service. No real network: the handshake is injected, and the
certificate handed to the parser is real DER built here with `cryptography`,
so the parsing is exercised against genuine bytes rather than a stand-in dict.
"""

from __future__ import annotations

import asyncio
import contextlib
import datetime
import socket
import ssl
import threading

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

from app.core import ssrf
from app.core.ssrf import SsrfBlocked
from app.services import tls_service

PUBLIC_IP = "93.184.216.34"
OTHER_PUBLIC_IP = "8.8.8.8"
LOOPBACK_IP = "127.0.0.1"

NOW = datetime.datetime.now(datetime.timezone.utc)

_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


def build_certificate(
    *,
    common_name: str = "example.com",
    issuer_cn: str | None = None,
    organization: str = "OSINT Test Authority",
    not_before: datetime.datetime | None = None,
    not_after: datetime.datetime | None = None,
    dns_names: list[str] | None = None,
    serial: int = 0x0A0B0C0D,
) -> bytes:
    """Real DER, signed, so the service parses an actual certificate."""
    subject = x509.Name(
        [
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, organization),
            x509.NameAttribute(NameOID.COMMON_NAME, common_name),
        ]
    )
    issuer_name = subject
    if issuer_cn is not None:
        issuer_name = x509.Name(
            [
                x509.NameAttribute(NameOID.ORGANIZATION_NAME, organization),
                x509.NameAttribute(NameOID.COMMON_NAME, issuer_cn),
            ]
        )
    builder = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer_name)
        .public_key(_KEY.public_key())
        .serial_number(serial)
        .not_valid_before(not_before or (NOW - datetime.timedelta(days=1)))
        .not_valid_after(not_after or (NOW + datetime.timedelta(days=90)))
    )
    if dns_names is not None:
        builder = builder.add_extension(
            x509.SubjectAlternativeName([x509.DNSName(n) for n in dns_names]),
            critical=False,
        )
    return builder.sign(_KEY, hashes.SHA256()).public_bytes(serialization.Encoding.DER)


def install(
    monkeypatch,
    der: bytes,
    *,
    addresses: list[str] | None = None,
    tls_version: str = "TLSv1.3",
    cipher: str = "TLS_AES_256_GCM_SHA384",
) -> list[tuple]:
    """Point the service at a fixed cert and record every handshake call."""
    calls: list[tuple] = []

    async def fake_handshake(address, port, sni):
        calls.append((address, port, sni))
        return der, tls_version, cipher

    async def fake_validate_host(host, port=443):
        return list(addresses if addresses is not None else [PUBLIC_IP])

    monkeypatch.setattr(tls_service, "_handshake", fake_handshake)
    monkeypatch.setattr(tls_service, "validate_host", fake_validate_host)
    return calls


@pytest.mark.asyncio
async def test_parses_a_live_certificate_into_the_reported_shape(monkeypatch):
    install(
        monkeypatch,
        build_certificate(
            common_name="example.com",
            issuer_cn="R3",
            not_before=NOW - datetime.timedelta(days=5),
            not_after=NOW + datetime.timedelta(days=85),
            dns_names=["example.com", "www.example.com", "*.example.com"],
        ),
    )

    result = await tls_service.lookup("example.com")

    assert result["source"] == "TLS"
    assert result["host"] == "example.com"
    assert result["port"] == 443
    assert result["resolved_ip"] == PUBLIC_IP
    assert result["subject"] == "CN=example.com,O=OSINT Test Authority"
    assert result["issuer"] == "CN=R3,O=OSINT Test Authority"
    assert result["not_before"].endswith("Z")
    assert result["not_after"].endswith("Z")
    assert result["expired"] is False
    assert result["not_yet_valid"] is False
    assert result["self_signed"] is False
    assert result["serial_number"] == "0xa0b0c0d"
    assert result["signature_algorithm"] == "sha256WithRSAEncryption"
    assert result["san_dns_names"] == [
        "example.com",
        "www.example.com",
        "*.example.com",
    ]
    assert result["san_truncated"] is False
    assert result["tls_version"] == "TLSv1.3"
    assert result["cipher"] == "TLS_AES_256_GCM_SHA384"
    assert 80 <= result["days_remaining"] <= 85
    # Every value must survive a JSON round trip: this dict is persisted and
    # returned by the API.
    assert isinstance(result, dict)
    assert all(
        isinstance(v, (str, int, bool, list, type(None))) for v in result.values()
    )


@pytest.mark.asyncio
async def test_expired_certificate_reports_negative_days_remaining(monkeypatch):
    install(
        monkeypatch,
        build_certificate(
            not_before=NOW - datetime.timedelta(days=400),
            not_after=NOW - datetime.timedelta(days=6, hours=12),
        ),
    )

    result = await tls_service.lookup("example.com")

    assert result["expired"] is True
    # The whole point: clamped to 0 this would render as "expires today".
    assert result["days_remaining"] == -7
    assert result["days_remaining"] < 0
    assert "EXPIRED" in result["note"]


@pytest.mark.asyncio
async def test_not_yet_valid_certificate_is_flagged(monkeypatch):
    install(
        monkeypatch,
        build_certificate(
            not_before=NOW + datetime.timedelta(days=2),
            not_after=NOW + datetime.timedelta(days=92),
        ),
    )

    result = await tls_service.lookup("example.com")

    assert result["not_yet_valid"] is True
    assert result["expired"] is False
    assert "Not valid yet" in result["note"]


@pytest.mark.asyncio
async def test_subject_equal_to_issuer_is_reported_as_self_signed(monkeypatch):
    # issuer_cn left as None => issuer is the same DN as the subject.
    install(monkeypatch, build_certificate(common_name="example.com"))

    result = await tls_service.lookup("example.com")

    assert result["subject"] == result["issuer"]
    assert result["self_signed"] is True
    assert "self-signed" in result["note"]


@pytest.mark.asyncio
async def test_distinct_issuer_is_not_self_signed(monkeypatch):
    install(monkeypatch, build_certificate(common_name="example.com", issuer_cn="R3"))

    result = await tls_service.lookup("example.com")

    assert result["self_signed"] is False


@pytest.mark.asyncio
async def test_san_entries_are_capped_and_truncation_is_declared(monkeypatch):
    names = [f"host{i:03d}.example.com" for i in range(250)]
    install(monkeypatch, build_certificate(dns_names=names))

    result = await tls_service.lookup("example.com")

    assert len(result["san_dns_names"]) == 100
    assert result["san_dns_names"][0] == "host000.example.com"
    assert result["san_dns_names"][-1] == "host099.example.com"
    assert result["san_truncated"] is True


@pytest.mark.asyncio
async def test_san_entries_are_not_marked_truncated_under_the_cap(monkeypatch):
    names = [f"host{i:03d}.example.com" for i in range(100)]
    install(monkeypatch, build_certificate(dns_names=names))

    result = await tls_service.lookup("example.com")

    assert len(result["san_dns_names"]) == 100
    assert result["san_truncated"] is False


@pytest.mark.asyncio
async def test_certificate_without_a_san_extension_reports_an_empty_list(monkeypatch):
    install(monkeypatch, build_certificate(dns_names=None))

    result = await tls_service.lookup("example.com")

    assert result["san_dns_names"] == []
    assert result["san_truncated"] is False


@pytest.mark.asyncio
async def test_long_dn_and_san_strings_are_truncated(monkeypatch):
    # A legacy or hostile certificate really can carry a DN and a SAN entry well
    # past our cap, so this proves the cap fires rather than assuming it does.
    huge = "a" * 900
    install(
        monkeypatch,
        build_certificate(
            common_name="example.com", organization=huge, dns_names=[huge]
        ),
    )

    result = await tls_service.lookup("example.com")

    assert len(result["subject"]) == 512
    assert len(result["issuer"]) == 512
    assert result["san_dns_names"] == [huge[:512]]
    assert len(result["note"]) <= 300


@pytest.mark.asyncio
async def test_dials_the_address_the_guard_validated_not_the_name(monkeypatch):
    """The anti-rebinding test. If this regresses, DNS rebinding walks in."""
    calls = install(
        monkeypatch, build_certificate(), addresses=[PUBLIC_IP, OTHER_PUBLIC_IP]
    )

    result = await tls_service.lookup("example.com")

    assert len(calls) == 1
    address, port, sni = calls[0]
    assert address == PUBLIC_IP
    assert address != "example.com"
    assert port == 443
    # SNI carries the name, or a multi-vhost target serves the wrong cert.
    assert sni == "example.com"
    assert result["resolved_ip"] == PUBLIC_IP


@pytest.mark.asyncio
async def test_non_default_port_is_used_for_the_dial(monkeypatch):
    calls = install(monkeypatch, build_certificate())

    result = await tls_service.lookup("example.com", port=8443)

    assert calls[0][1] == 8443
    assert result["port"] == 8443


@pytest.mark.asyncio
async def test_ip_literal_target_sends_no_sni(monkeypatch):
    # SNI with an IP address is invalid; asyncio would otherwise substitute the
    # host we dialled (the pinned IP) as the server name.
    calls = install(monkeypatch, build_certificate(common_name="pinned.example.net"))

    result = await tls_service.lookup("93.184.216.34")

    assert calls[0][0] == PUBLIC_IP
    assert calls[0][2] == ""
    assert result["host"] == "93.184.216.34"
    # Without SNI most hosts serve a default certificate for another name; the
    # note has to say so or the mismatch reads as a finding.
    assert "no SNI" in result["note"]
    assert "default certificate" in result["note"]


@pytest.mark.asyncio
async def test_note_survives_the_char_cap_with_every_finding_present(monkeypatch):
    # The cap is 300 and truncation is silent, so the worst realistic combination
    # has to be asserted complete — otherwise a future wording change quietly
    # eats the finding that matters.
    install(
        monkeypatch,
        build_certificate(
            not_before=NOW - datetime.timedelta(days=400),
            not_after=NOW - datetime.timedelta(days=3),
        ),
    )

    result = await tls_service.lookup("93.184.216.34")

    assert result["expired"] is True
    assert result["self_signed"] is True
    assert len(result["note"]) <= 300
    assert "not chain-validated" in result["note"]
    assert "no SNI" in result["note"]
    # Computed from the result so the assertion tracks the floor semantics
    # instead of racing the sub-second drift between the fixture clock and now.
    assert f"EXPIRED {-result['days_remaining']} days ago" in result["note"]
    assert "self-signed" in result["note"]


@pytest.mark.asyncio
async def test_expiry_within_a_day_floors_to_zero_and_says_so(monkeypatch):
    install(monkeypatch, build_certificate(not_after=NOW + datetime.timedelta(hours=6)))

    result = await tls_service.lookup("example.com")

    # 6 hours out floors to 0 days, which is truthful ("today"). The direction
    # that must never read as 0 is the expired one.
    assert result["days_remaining"] == 0
    assert result["expired"] is False
    assert "Expires in 0 days." in result["note"]


@pytest.mark.asyncio
async def test_certificate_expired_hours_ago_reports_negative_days(monkeypatch):
    install(monkeypatch, build_certificate(not_after=NOW - datetime.timedelta(hours=6)))

    result = await tls_service.lookup("example.com")

    assert result["expired"] is True
    assert result["days_remaining"] == -1
    assert "EXPIRED 1 day ago" in result["note"]


@pytest.mark.asyncio
async def test_bracketed_ipv6_target_is_normalised_and_sends_no_sni(monkeypatch):
    v6 = "2606:2800:220:1:248:1893:25c8:1946"
    calls = install(monkeypatch, build_certificate(), addresses=[v6])

    result = await tls_service.lookup(f"[{v6}]")

    assert calls[0][0] == v6
    assert calls[0][2] == ""
    assert result["host"] == v6


@pytest.mark.asyncio
async def test_ssrf_blocked_propagates_when_the_name_answers_loopback(monkeypatch):
    """The real guard, not a stub: 127.0.0.1 must stop us before any socket."""
    dialled: list[tuple] = []

    async def fake_handshake(address, port, sni):
        dialled.append((address, port, sni))
        return build_certificate(), "TLSv1.3", "TLS_AES_256_GCM_SHA384"

    monkeypatch.setattr(tls_service, "_handshake", fake_handshake)
    monkeypatch.setattr(ssrf, "_sync_resolve_all", lambda host, port: [LOOPBACK_IP])

    with pytest.raises(SsrfBlocked, match="blocked address"):
        await tls_service.lookup("internal.example.com")

    assert dialled == [], "a blocked target must never be dialled"


@pytest.mark.asyncio
async def test_ssrf_blocked_propagates_for_the_cloud_metadata_address(monkeypatch):
    monkeypatch.setattr(
        ssrf, "_sync_resolve_all", lambda host, port: ["169.254.169.254"]
    )

    with pytest.raises(SsrfBlocked):
        await tls_service.lookup("metadata.example.com")


@pytest.mark.asyncio
async def test_ssrf_blocked_propagates_when_the_name_does_not_resolve(monkeypatch):
    monkeypatch.setattr(ssrf, "_sync_resolve_all", lambda host, port: [])

    with pytest.raises(SsrfBlocked, match="did not resolve"):
        await tls_service.lookup("nope.example.com")


@pytest.mark.asyncio
async def test_connection_refused_is_an_honest_failure_not_an_empty_cert(monkeypatch):
    async def refuse(address, port, sni):
        raise ConnectionRefusedError(111, "Connection refused")

    async def allow(host, port=443):
        return [PUBLIC_IP]

    monkeypatch.setattr(tls_service, "_handshake", refuse)
    monkeypatch.setattr(tls_service, "validate_host", allow)

    with pytest.raises(tls_service.TlsLookupError) as excinfo:
        await tls_service.lookup("example.com")

    message = str(excinfo.value)
    assert "refused" in message
    assert "no TLS service" in message
    assert "example.com:443" in message


@pytest.mark.asyncio
async def test_plain_http_endpoint_is_reported_as_non_tls(monkeypatch):
    async def speak_http(address, port, sni):
        raise ssl.SSLError("[SSL: WRONG_VERSION_NUMBER] wrong version number")

    async def allow(host, port=443):
        return [PUBLIC_IP]

    monkeypatch.setattr(tls_service, "_handshake", speak_http)
    monkeypatch.setattr(tls_service, "validate_host", allow)

    with pytest.raises(tls_service.TlsLookupError, match="non-TLS protocol"):
        await tls_service.lookup("example.com")


@pytest.mark.asyncio
async def test_connection_closed_mid_handshake_is_not_reported_as_no_certificate(
    monkeypatch,
):
    # Windows and macOS flatten a rejected record layer into a reset/abort, so
    # this must still read as "no TLS here", not as an empty certificate.
    async def reset(address, port, sni):
        raise ConnectionResetError(104, "Connection reset by peer")

    async def allow(host, port=443):
        return [PUBLIC_IP]

    monkeypatch.setattr(tls_service, "_handshake", reset)
    monkeypatch.setattr(tls_service, "validate_host", allow)

    with pytest.raises(tls_service.TlsLookupError, match="no TLS service on this port"):
        await tls_service.lookup("example.com")


@pytest.mark.asyncio
async def test_handshake_timeout_is_translated(monkeypatch):
    async def hang(address, port, sni):
        await asyncio.sleep(30)

    async def allow(host, port=443):
        return [PUBLIC_IP]

    monkeypatch.setattr(tls_service, "_handshake", hang)
    monkeypatch.setattr(tls_service, "validate_host", allow)

    with pytest.raises(tls_service.TlsLookupError, match="no certificate within"):
        await tls_service.lookup("example.com")


@pytest.mark.asyncio
async def test_handshake_raising_without_a_certificate_propagates(monkeypatch):
    async def anonymous(address, port, sni):
        raise tls_service.TlsLookupError("handshake completed but no certificate")

    async def allow(host, port=443):
        return [PUBLIC_IP]

    monkeypatch.setattr(tls_service, "_handshake", anonymous)
    monkeypatch.setattr(tls_service, "validate_host", allow)

    with pytest.raises(tls_service.TlsLookupError, match="no certificate"):
        await tls_service.lookup("example.com")


@pytest.mark.asyncio
async def test_unparseable_certificate_bytes_are_an_honest_failure(monkeypatch):
    install(monkeypatch, b"\x16\x03\x01\x00\x9fdefinitely not a certificate")

    with pytest.raises(tls_service.TlsLookupError, match="not a parseable certificate"):
        await tls_service.lookup("example.com")


@pytest.mark.asyncio
async def test_missing_tls_version_and_cipher_are_reported_as_null(monkeypatch):
    install(monkeypatch, build_certificate(), tls_version=None, cipher=None)

    result = await tls_service.lookup("example.com")

    assert result["tls_version"] == "unknown"
    assert result["cipher"] is None


@pytest.mark.parametrize("bad_port", [0, -1, 65536])
@pytest.mark.asyncio
async def test_out_of_range_port_is_rejected_before_any_connection(bad_port):
    with pytest.raises(ValueError, match="port must be between"):
        await tls_service.lookup("example.com", port=bad_port)


@pytest.mark.parametrize(
    "bad_target",
    ["", "   ", "https://example.com", "example.com/admin", "user@example.com"],
)
@pytest.mark.asyncio
async def test_url_shaped_targets_are_rejected(bad_target):
    with pytest.raises(ValueError):
        await tls_service.lookup(bad_target)


def test_client_context_does_not_verify():
    """The no-verify choice is load-bearing; assert it, do not assume it.

    A context that verified would turn every expired / self-signed / mismatched
    certificate — the findings this module exists to surface — into a handshake
    error and report nothing.
    """
    ctx = tls_service._client_context()
    assert ctx.verify_mode is ssl.CERT_NONE
    assert ctx.check_hostname is False


def test_tls_error_is_a_runtime_error_so_the_orchestrator_folds_it_into_partial():
    # orchestrator._with_timeout catches Exception -> RuntimeError -> errors[],
    # so this class has to stay a RuntimeError for a failed handshake to be a
    # partial scan rather than a 500.
    assert issubclass(tls_service.TlsLookupError, RuntimeError)


@pytest.mark.asyncio
async def test_real_handshake_reads_the_peer_certificate(tmp_path):
    """Exercise the un-stubbed `_handshake` against a loopback TLS listener.

    Every other test injects `_handshake`, so nothing else covers the parts that
    are easy to get subtly wrong: that a CERT_NONE context really does return DER
    from `getpeercert(binary_form=True)` (the decoded dict form is `{}`), and
    that the empty-string SNI is accepted. Loopback only — no egress, and no
    port probing of anything but a socket this test owns.
    """
    cert_path = tmp_path / "cert.pem"
    key_path = tmp_path / "key.pem"
    cert = (
        x509.CertificateBuilder()
        .subject_name(
            x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "loopback.test")])
        )
        .issuer_name(
            x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "loopback.test")])
        )
        .public_key(_KEY.public_key())
        .serial_number(0x5A5A5A5A)
        .not_valid_before(NOW - datetime.timedelta(days=1))
        .not_valid_after(NOW + datetime.timedelta(days=30))
        .sign(_KEY, hashes.SHA256())
    )
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(
        _KEY.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )

    server_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server_ctx.load_cert_chain(cert_path, key_path)

    listener = socket.socket()
    try:
        listener.bind(("127.0.0.1", 0))
    except OSError as e:  # pragma: no cover - sandboxed runner
        pytest.skip(f"cannot bind a loopback listener: {e}")
    listener.listen(5)
    port = listener.getsockname()[1]

    def serve() -> None:
        while True:
            try:
                conn, _ = listener.accept()
            except OSError:
                return
            # The client hangs up after reading the certificate, so a failed wrap
            # is the expected outcome here, not a test failure.
            with contextlib.suppress(OSError, ssl.SSLError):
                server_ctx.wrap_socket(conn, server_side=True).close()

    threading.Thread(target=serve, daemon=True).start()
    try:
        der, tls_version, cipher = await tls_service._handshake("127.0.0.1", port, "")
    finally:
        listener.close()

    parsed = x509.load_der_x509_certificate(der)
    assert parsed.serial_number == 0x5A5A5A5A
    assert parsed.subject.rfc4514_string() == "CN=loopback.test"
    assert tls_version is not None and tls_version.startswith("TLS")
    assert cipher
