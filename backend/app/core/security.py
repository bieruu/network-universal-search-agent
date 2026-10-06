"""Auth + input hardening. Secrets only via env; never logged/returned."""

from __future__ import annotations

import base64
import hmac
import ipaddress
from urllib.parse import unquote

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.db.session import get_session

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
            decoded = unquote(value.strip())
            return decoded if len(decoded) <= 512 else None
    return None


def _unwrap_session_token(value: str, secret: str) -> str | None:
    if "." not in value:
        return value
    token, signature = value.rsplit(".", 1)
    if not token or not signature:
        return None
    expected = base64.b64encode(
        hmac.new(secret.encode(), token.encode(), "sha256").digest()
    ).decode("ascii")
    return token if hmac.compare_digest(signature, expected) else None


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
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> str:
    """Verify a Better Auth session against its shared PostgreSQL session store."""
    secret = (settings.better_auth_secret or "").strip()
    if (
        not secret
        or secret
        in {"change-me-32-chars-min", "dev-secret-min-32-chars-change-me-xxxx"}
        or secret.lower().startswith(
            ("replace-with", "change-me", "dev-secret", "your-secret")
        )
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication is not configured with a valid secret",
        )

    if authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(" ", 1)[1].strip()
        # Fail closed: only a dedicated SERVICE_TOKEN grants service access.
        # The session-signing secret must never work as an API key.
        service_token = (settings.service_token or "").strip()
        if token and service_token and hmac.compare_digest(token, service_token):
            return "user:service"
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized"
        )

    session_token = _parse_cookie_value(
        cookie,
        "better-auth.session_token",
        "__Secure-better-auth.session_token",
    )
    if session_token:
        session_token = _unwrap_session_token(session_token, secret)
    if session_token:
        if not settings.database_url.startswith(
            ("postgresql://", "postgresql+asyncpg://")
        ):
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="PostgreSQL session store is not configured",
            )
        result = await session.execute(
            text(
                'SELECT "userId" FROM "session" '
                'WHERE token = :token AND "expiresAt" > CURRENT_TIMESTAMP LIMIT 1'
            ),
            {"token": session_token},
        )
        user_id = result.scalar_one_or_none()
        if isinstance(user_id, str) and user_id.strip():
            return f"user:{user_id.strip()}"

    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")


UserDep = Depends(require_user)
