"""Live TLS certificate detail: the certificate a host actually serves *now*.

Overlap with the passive CT sources (checked before writing this module, as the
TODO asks): `certspotter_service` and `crtsh_service` already return, per
deduplicated name, `subdomain` + `issuer` + `not_before` + `not_after`, and
Cert Spotter expands `dns_names` — so DNS names, an issuer label and a validity
window are all obtainable passively. What CT structurally *cannot* give is the
certificate currently on the wire: CT only knows about certificates that were
logged, it reports every issuance history for a zone rather than the one the
server is serving now, and it never shows the negotiated TLS version, the
cipher, or a hostname mismatch against the live leaf. Those are the gaps this
module fills, and they are why an active handshake is warranted at all.

It is an *active* module — the backend opens a socket to an attacker-chosen
host — so three things are deliberate and load-bearing:

1. **Pin to the address `validate_host` returned, never re-resolve.** The guard
   resolves, checks every answer, and hands them back. Re-resolving the name
   here would make that check decorative: DNS rebinding answers the check with a
   public IP and the connect with 127.0.0.1 / 169.254.169.254, and the socket
   goes exactly where the guard never approved.
2. **Do not verify the certificate.** `check_hostname=False`,
   `verify_mode=CERT_NONE`. An OSINT scan must *report* an expired, self-signed
   or hostname-mismatched certificate — that is the finding. A verifying client
   turns every one of them into a handshake failure and hides them behind
   "certificate verify failed", which is the exact opposite of the job.
3. **Never send an HTTP request.** Handshake, read the peer certificate, close.
   This is not an active scan and must not become one (AGENTS.md §7).

With `verify_mode=CERT_NONE` the stdlib refuses to decode the certificate for
us — `getpeercert()` returns `{}` — so we take `getpeercert(binary_form=True)`
and hand the DER to `cryptography`. That is also why this is `cryptography`
rather than a hand-rolled DER walk: decoding, extensions, SANs and RFC 4514
name formatting are a solved problem there and a source of silent misparsing
here.
"""

from __future__ import annotations

import asyncio
import contextlib
import ipaddress
import ssl
from datetime import datetime, timezone
from typing import Any

from cryptography import x509

from app.core.config import settings
from app.core.ssrf import validate_host

SOURCE = "TLS"

_MAX_FIELD_CHARS = 512
_MAX_NOTE_CHARS = 300
_MAX_DETAIL_CHARS = 160
_MAX_SAN_ENTRIES = 100

# OpenSSL's words for "the other end is not speaking TLS". Matched case-folded
# against the exception text and `.reason`, because that is all a caller gets
# once the library has flattened the alert.
_NOT_TLS_MARKERS = (
    "wrong_version_number",
    "unsupported_protocol",
    "http_request",
    "tlsv1 alert protocol version",
    "tlsv1 alert unrecognized_name",
    "packet_length_too_long",
    "record layer failure",
    "unknown protocol",
)


class TlsLookupError(RuntimeError):
    """No certificate could be read from `host:port`.

    Raised instead of returning a certificate-shaped dict with empty fields: a
    target that answers with plain HTTP, closes the connection, or presents
    garbage has *no* certificate, and reporting that as an empty certificate
    would render as "no certificate found" in the UI — a claim we cannot make.
    The message is written to be shown to a user verbatim.
    """


def _normalize_host(target: str) -> str:
    """Accept a bare hostname or IP literal; reject anything URL-shaped."""
    host = str(target).strip()
    # A bracketed IPv6 literal is what a URL authority carries; the resolver and
    # ssl want the bare address.
    if host.startswith("[") and host.endswith("]"):
        host = host[1:-1]
    host = host.lower()
    if not host or len(host) > 253:
        raise ValueError("target must be a hostname or IP address")
    if "/" in host or "@" in host or (":" in host and not _is_ip_literal(host)):
        raise ValueError("target must be a bare hostname or IP address, not a URL")
    return host


def _is_ip_literal(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return False
    return True


def _client_context() -> ssl.SSLContext:
    """A context that accepts any certificate, on purpose.

    See the module docstring, point 2. `check_hostname` must be cleared before
    `verify_mode`, and `verify_mode` must be cleared before any handshake: the
    stdlib refuses `CERT_NONE` while hostname checking is on, and we would then
    silently verify against a private CA store.
    """
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


async def _handshake(
    address: str, port: int, sni: str
) -> tuple[bytes, str | None, str | None]:
    """Dial one validated address, handshake, read the peer cert, close.

    Returns `(der_bytes, tls_version, cipher)`. No bytes are read from the
    application stream and none are written — see the module docstring, point 3.

    `address` must be an address `validate_host` already approved. `host` here is
    that address literal, so the resolver only has to parse it; the name is
    never looked up a second time, which is what keeps DNS rebinding out.
    """
    # The reader is discarded on purpose: nothing may be read from the
    # application stream, which is what would turn this into a request.
    _, writer = await asyncio.open_connection(
        host=address,
        port=port,
        ssl=_client_context(),
        server_hostname=sni,
    )
    try:
        tls = writer.get_extra_info("ssl_object")
        der = tls.getpeercert(binary_form=True)
        if not der:
            raise TlsLookupError(
                "handshake completed but the peer presented no certificate "
                "(anonymous cipher suite)"
            )
        cipher = tls.cipher()
        return der, tls.version(), (cipher[0] if cipher else None)
    finally:
        writer.close()
        with contextlib.suppress(OSError):
            await writer.wait_closed()


def _name_str(name: x509.Name) -> str:
    # rfc4514_string() is the readable form ("CN=example.com,O=Example"). A
    # hostile-but-well-formed DN can still be arbitrarily long, so it is capped.
    return name.rfc4514_string()[:_MAX_FIELD_CHARS]


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _signature_algorithm(cert: x509.Certificate) -> str:
    oid = cert.signature_algorithm_oid
    # `dotted_string` is public; `_name` is the registry's human-readable label
    # ("sha256WithRSAEncryption") and is only a nicety, so fall back to the OID.
    return (getattr(oid, "_name", None) or oid.dotted_string)[:_MAX_FIELD_CHARS]


def _san_dns_names(cert: x509.Certificate) -> tuple[list[str], bool]:
    try:
        san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    except x509.ExtensionNotFound:
        # Genuinely absent, which is a fact worth reporting as an empty list.
        return [], False
    names = san.get_values_for_type(x509.DNSName)
    capped = [str(name)[:_MAX_FIELD_CHARS] for name in names[:_MAX_SAN_ENTRIES]]
    return capped, len(names) > _MAX_SAN_ENTRIES


def _read_certificate(der: bytes) -> dict[str, Any]:
    """Decode DER and pull out every field we report. Runs in a thread.

    Kept whole, and off the event loop, because every call into `cryptography`
    is CPU-bound work on bytes a remote host chose. A malformed certificate is
    left to raise: the caller turns that into an honest failure.
    """
    cert = x509.load_der_x509_certificate(der)
    subject = _name_str(cert.subject)
    issuer = _name_str(cert.issuer)
    san_dns_names, san_truncated = _san_dns_names(cert)
    return {
        "subject": subject,
        "issuer": issuer,
        "not_before": _iso(cert.not_valid_before_utc),
        "not_after": _iso(cert.not_valid_after_utc),
        "serial_number": hex(cert.serial_number)[:_MAX_FIELD_CHARS],
        "signature_algorithm": _signature_algorithm(cert),
        "san_dns_names": san_dns_names,
        "san_truncated": san_truncated,
        # subject == issuer is a *heuristic*, not a signature check: a cert
        # issued by a private CA that reuses its own name looks identical here.
        # It is cheap and it is the honest minimum; nothing below claims more.
        "self_signed": subject == issuer,
    }


def _days_phrase(count: int) -> str:
    """`1 day` / `7 days`, always positive — callers pass a signed delta."""
    magnitude = abs(count)
    return f"{magnitude} {'day' if magnitude == 1 else 'days'}"


def _note(
    *,
    expired: bool,
    not_yet_valid: bool,
    self_signed: bool,
    days_remaining: int,
    is_ip: bool,
) -> str:
    parts = [
        (
            "Live handshake read; not chain-validated (an OSINT scan reports cert "
            "problems instead of failing on them)."
        )
    ]
    if is_ip:
        # Worth saying out loud: without SNI most hosts answer with a default
        # certificate covering some other name, so subject/SANs will not match
        # the address the user typed. That is expected, not a finding.
        parts.append("Dialed by IP with no SNI, so this may be a default certificate.")
    if expired:
        parts.append(f"Certificate EXPIRED {_days_phrase(days_remaining)} ago.")
    elif days_remaining <= 30:
        parts.append(f"Expires in {_days_phrase(days_remaining)}.")
    if not_yet_valid:
        parts.append("Not valid yet.")
    if self_signed:
        parts.append("Subject equals issuer: self-signed or a private CA.")
    return "; ".join(parts)[:_MAX_NOTE_CHARS]


def _describe_failure(exc: BaseException) -> str:
    """Turn a transport/TLS exception into a sentence a user can act on."""
    detail = f" ({type(exc).__name__})"
    if isinstance(exc, ConnectionRefusedError):
        return (
            "connection refused — nothing is listening on this port, so there "
            "is no TLS service here" + detail
        )
    haystack = f"{exc} {getattr(exc, 'reason', '')}".lower()
    if any(marker in haystack for marker in _NOT_TLS_MARKERS):
        return (
            "the peer answered with a non-TLS protocol (plain HTTP or another "
            "service), so there is no certificate to report" + detail
        )
    if isinstance(exc, ssl.SSLError):
        return (
            f"TLS handshake failed — no certificate was presented: "
            f"{str(exc)[:_MAX_DETAIL_CHARS]}"
        )
    if isinstance(exc, ConnectionError):
        # Includes reset/aborted, which is what a non-TLS listener usually looks
        # like on Windows and macOS: the record layer rejects the plaintext and
        # the peer hangs up before we can say anything more precise.
        return (
            "connection closed before a certificate was presented — there is no "
            "TLS service on this port" + detail
        )
    if isinstance(exc, OSError):
        return (
            f"connection failed: {type(exc).__name__}: {str(exc)[:_MAX_DETAIL_CHARS]}"
        )
    return f"TLS handshake failed: {type(exc).__name__}"


async def lookup(target: str, port: int = 443) -> dict[str, Any]:
    """Report the live TLS certificate served by `target:port`.

    `port` defaults to 443. `target` may be a hostname or an IP literal; for an
    IP literal no SNI is sent (SNI with an IP address is not valid), and the
    certificate that comes back is whatever that address serves, which for most
    hosts is a default certificate covering a different name — `note` says so.

    Raises `SsrfBlocked` (propagated from `validate_host`, never caught here)
    when the name resolves to a blocked address or cannot be resolved, and
    `TlsLookupError` when the handshake yields no certificate.
    """
    host = _normalize_host(target)
    if not 1 <= port <= 65535:
        raise ValueError(f"port must be between 1 and 65535, got {port}")

    # Anti-rebinding invariant: the guard resolves, checks *every* answer, and
    # returns them. We dial one of those addresses — never the name. Resolving
    # again here would hand a rebinding attacker a second, unchecked lookup and
    # make the guard decorative.
    addresses = await validate_host(host, port)
    address = addresses[0]

    # asyncio substitutes `host` for `server_hostname=None` when ssl is in play,
    # so "no SNI" has to be spelled as the empty string. Otherwise we would send
    # the *pinned IP* as SNI, which targets read as a nonsense server name.
    is_ip = _is_ip_literal(host)
    sni = "" if is_ip else host

    try:
        der, tls_version, cipher = await asyncio.wait_for(
            _handshake(address, port, sni),
            timeout=settings.fetch_timeout_seconds,
        )
    except TlsLookupError:
        raise
    except TimeoutError as e:
        raise TlsLookupError(
            f"{host}:{port}: no certificate within "
            f"{settings.fetch_timeout_seconds}s"
        ) from e
    except (ssl.SSLError, OSError) as e:
        raise TlsLookupError(f"{host}:{port}: {_describe_failure(e)}") from e

    try:
        fields = await asyncio.to_thread(_read_certificate, der)
    except ValueError as e:
        raise TlsLookupError(
            f"{host}:{port}: the peer presented bytes that are not a parseable "
            "certificate"
        ) from e

    # One clock reading for every comparison, so `expired` and `days_remaining`
    # cannot disagree with each other.
    now = datetime.now(timezone.utc)
    not_after = datetime.fromisoformat(str(fields["not_after"]).replace("Z", "+00:00"))
    not_before = datetime.fromisoformat(
        str(fields["not_before"]).replace("Z", "+00:00")
    )
    expired = now > not_after
    not_yet_valid = now < not_before
    # timedelta.days floors, so a certificate that expired six hours ago reads -1
    # rather than 0. Clamping to 0 would render as "expires today", which is a
    # different and materially wrong claim.
    days_remaining = (not_after - now).days
    self_signed = bool(fields["self_signed"])

    return {
        "source": SOURCE,
        "host": host,
        "port": port,
        # The address actually dialled, so a reader can tie this certificate to a
        # specific host rather than a name that may resolve differently later.
        "resolved_ip": address,
        "subject": fields["subject"],
        "issuer": fields["issuer"],
        "not_before": fields["not_before"],
        "not_after": fields["not_after"],
        "days_remaining": days_remaining,
        "expired": expired,
        "not_yet_valid": not_yet_valid,
        "self_signed": self_signed,
        "serial_number": fields["serial_number"],
        "signature_algorithm": fields["signature_algorithm"],
        "san_dns_names": fields["san_dns_names"],
        "san_truncated": fields["san_truncated"],
        "tls_version": (tls_version or "unknown")[:_MAX_FIELD_CHARS],
        "cipher": (cipher[:_MAX_FIELD_CHARS] if cipher else None),
        "note": _note(
            expired=expired,
            not_yet_valid=not_yet_valid,
            self_signed=self_signed,
            days_remaining=days_remaining,
            is_ip=is_ip,
        ),
    }
