"""Auth + input hardening. Secrets only via env; never logged/returned."""

from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import json
import time

from fastapi import Depends, Header, HTTPException, status

from app.core.config import settings

_PRIVATE_NETS = [
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
    ipaddress.ip_network("fe80::/10"),
]


def _decode_session_token(raw_token: str) -> str | None:
    if not raw_token or "." not in raw_token:
        return None

    payload_b64, signature = raw_token.rsplit(".", 1)
    if not payload_b64 or not signature:
        return None

    secret = (settings.better_auth_secret or "").strip()
    if not secret or secret in {"change-me-32-chars-min", "dev-secret-min-32-chars-change-me-xxxx"}:
        return None

    try:
        padding = "=" * (-len(payload_b64) % 4)
        payload_bytes = base64.urlsafe_b64decode((payload_b64 + padding).encode("ascii"))
        expected = hmac.new(secret.encode("utf-8"), payload_bytes, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            return None
        payload = json.loads(payload_bytes.decode("utf-8"))
    except (ValueError, TypeError, json.JSONDecodeError, UnicodeDecodeError):
        return None

    if not isinstance(payload, dict):
        return None

    expires_at = payload.get("exp")
    if isinstance(expires_at, (int, float)) and expires_at <= time.time():
        return None

    subject = payload.get("sub") or payload.get("user")
    if not isinstance(subject, str) or not subject.strip():
        return None
    return subject.strip()


def _parse_cookie_value(header: str | None, *names: str) -> str | None:
    if not header:
        return None
    for chunk in header.split(";"):
        part = chunk.strip()
        if not part:
            continue
        if "=" not in part:
            continue
        name, value = part.split("=", 1)
        if name.strip() in names:
            return value.strip()
    return None


def is_blocked_target(target: str) -> bool:
    t = target.strip().lower()
    if t in ("localhost",):
        return True
    try:
        ip = ipaddress.ip_address(t)
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
        ):
            return True
        return any(ip in net for net in _PRIVATE_NETS)
    except ValueError:
        return False


def assert_target_allowed(target: str) -> None:
    if is_blocked_target(target):
        raise HTTPException(
            status_code=400, detail="Private/localhost targets are blocked"
        )


async def require_user(
    authorization: str | None = Header(default=None),
    cookie: str | None = Header(default=None),
) -> str:
    """Verify Better Auth session cookie or a shared-secret bearer token.

    Fail closed: unsigned or default cookies are rejected; bearer tokens must
    match the configured secret exactly.
    """
    secret = (settings.better_auth_secret or "").strip()
    if not secret or secret in {"change-me-32-chars-min", "dev-secret-min-32-chars-change-me-xxxx"}:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication is not configured for production",
        )

    if authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(" ", 1)[1].strip()
        if token and hmac.compare_digest(token, secret):
            return "user:service"
        signed_subject = _decode_session_token(token)
        if signed_subject:
            return f"user:{signed_subject}"
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")

    session_token = _parse_cookie_value(
        cookie,
        "better-auth.session_token",
        "__Secure-better-auth.session_token",
    )
    if session_token:
        signed_subject = _decode_session_token(session_token)
        if signed_subject:
            return f"user:{signed_subject}"

    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")


UserDep = Depends(require_user)
