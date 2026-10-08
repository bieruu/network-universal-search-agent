"""Auth + input hardening. Secrets only via env; never logged/returned."""

from __future__ import annotations

import asyncio
import base64
import hmac
import ipaddress
import socket
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
    # "This network" / unspecified. Linux connects 0.0.0.0 to the loopback
    # interface, so a target that passes only the is_private/loopback/link_local
    # tests below still reaches localhost. Caught by is_unspecified, which the
    # flag test also covers for ::.
    ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("::/128"),
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
            or ip.is_unspecified
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


def _looks_like_ip(target: str) -> bool:
    try:
        ipaddress.ip_address(target.strip())
        return True
    except ValueError:
        return False


def _sync_resolve(host: str) -> str:
    """Blocking resolver body. Only ever reached through asyncio.to_thread."""
    return socket.gethostbyname(host)


async def resolve_target_ip(target: str) -> str:
    """Resolve a hostname off the event loop, bounded by the Shodan budget.

    gethostbyname blocks for as long as the resolver takes, which would stall
    every other request on the worker (AGENTS.md §3), so the call goes to a
    thread. wait_for releases the caller on time; the stuck thread itself cannot
    be cancelled and finishes on its own.
    """
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(_sync_resolve, target),
            timeout=settings.scan_timeout_shodan,
        )
    # OSError covers socket.gaierror; the TimeoutError wait_for raises subclasses
    # it too, so both paths keep the DNS failure wording callers already expect.
    except (OSError, asyncio.TimeoutError) as e:
        raise RuntimeError(f"DNS resolve failed: {e}") from e


async def assert_resolved_target_allowed(target: str) -> str | None:
    """Extend assert_target_allowed to the IP a hostname actually points at.

    A public-looking name can still resolve to 127.0.0.1 or 169.254.169.254,
    which the string check cannot see, and resolution here also keeps the scan
    endpoint from doubling as a free DNS oracle for enumerating internal names.
    An unresolvable name is left to the normal per-source error path — a failing
    source is a partial result, never a 500 (AGENTS.md §5.4).

    Returns the IP a *hostname* target resolved to, so the caller can hand that
    answer down instead of paying for the same lookup a second time, or None
    when there is nothing to hand down:
      - an unresolvable name (the source still resolves for itself, so a
        transient resolver blip here is not turned into a permanent shodan
        failure by us);
      - an IP literal, which shodan_service already uses verbatim without ever
        calling the resolver, so threading it would change nothing.
    """
    assert_target_allowed(target)
    if _looks_like_ip(target):
        return None
    try:
        ip = await resolve_target_ip(target)
    except RuntimeError:
        return None
    assert_target_allowed(ip)
    return ip


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
