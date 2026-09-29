"""Auth + input hardening. Secrets only via env; never logged/returned."""

from __future__ import annotations

import hmac
import ipaddress

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
    """Verify Better Auth session stub.

    Expects `Authorization: Bearer <session-token>` or a session cookie.
    Real verification uses BETTER_AUTH_SECRET (shared secret / JWKS in prod).
    Fail-closed: anything else → 401. Returned labels carry no token material.
    """
    token: str | None = None
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(" ", 1)[1].strip()
    elif cookie and "better-auth.session" in cookie:
        token = "cookie-session-present"
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized"
        )
    if token == "cookie-session-present":
        return "user:session"
    if settings.better_auth_secret and hmac.compare_digest(
        token, settings.better_auth_secret
    ):
        return "user:service"
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")


UserDep = Depends(require_user)
