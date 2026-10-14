"""Auth + input hardening. Secrets only via env; never logged/returned."""

from __future__ import annotations

import asyncio
import base64
import hmac
import ipaddress
import re
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


async def _session_subject(
    authorization: str | None,
    cookie: str | None,
    session: AsyncSession,
) -> str | None:
    """The authenticated subject for this request, or `None` when there is none.

    Everything `require_user` did before it was split lives here, including the
    two branches that RAISE instead of returning `None`:

      * a malformed/unset `BETTER_AUTH_SECRET` (401) — nothing can be trusted to
        be signed, including the guest token verified by `require_user_or_guest`;
      * a `Bearer` token that does not match `SERVICE_TOKEN` (401) — a failed
        credential attempt must never fall through to a weaker one;
      * a session cookie present while the store is not PostgreSQL (503) — the
        operator error stays visible rather than silently downgrading to guest.

    Returning `None` means "no usable session": absent cookie, or a token the
    session store did not honour. The caller decides what that permits.
    """
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

    return None


# Frontend mint format, pinned on both sides (`frontend/app/api/scan/.../route.ts`
# is the only minter): 16 random bytes as lowercase hex. The shape is checked
# before the signature so an attacker-controlled string can never become the key
# of a rate-limit bucket or a log field — the id is data, not a namespace.
# `fullmatch`, not `match`: `$` also accepts a trailing newline, and this value
# ends up in a bucket key.
_GUEST_ID_PATTERN = re.compile(r"[0-9a-f]{32}")


def _unwrap_guest_token(value: str, secret: str) -> str | None:
    """`<guest-id>.<signature>` → guest id, or `None` if anything is off.

    The signature is `base64url_unpadded(hmac_sha256(secret, "nusa-guest:" + id))`.
    The `"nusa-guest:"` prefix is domain separation: the same shared
    `BETTER_AUTH_SECRET` signs session cookies here, and a signature that is
    valid in one namespace must not be replayable in the other. Unpadded base64url
    is what `crypto.createHmac(...).digest("base64url")` emits in the minter, so
    the two sides agree without a padding round-trip.

    `hmac.compare_digest` compares, never `==` — same rule as the session and
    service-token paths.
    """
    if "." not in value:
        return None
    guest_id, signature = value.rsplit(".", 1)
    if not guest_id or not signature:
        return None
    if not _GUEST_ID_PATTERN.fullmatch(guest_id):
        return None
    expected = (
        base64.urlsafe_b64encode(
            hmac.new(
                secret.encode(), f"nusa-guest:{guest_id}".encode(), "sha256"
            ).digest()
        )
        .decode("ascii")
        .rstrip("=")
    )
    return guest_id if hmac.compare_digest(signature, expected) else None


async def require_user(
    authorization: str | None = Header(default=None),
    cookie: str | None = Header(default=None),
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> str:
    """Verify a Better Auth session against its shared PostgreSQL session store."""
    subject = await _session_subject(authorization, cookie, session)
    if subject is not None:
        return subject
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")


async def require_user_or_guest(
    guest_token: str | None = Header(default=None, alias="x-guest-token"),
    authorization: str | None = Header(default=None),
    cookie: str | None = Header(default=None),
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> str:
    """A signed-in subject (`user:<id>` / `user:service`) or a guest (`guest:<id>`).

    The two scan endpoints (`POST /api/v1/scan`, `GET /api/v1/scan/{id}`) are the
    ONLY routes on this dependency — history, trend, analysis and health keep
    `require_user()`, so a guest can scan but can never enumerate an account's
    saved scans (reversal note: DESIGN.md, 2026-10-14).

    The subject string is the ownership key: a guest reads only rows written as
    its own `guest:<id>`, so two guests and every account are mutually invisible
    without a second code path in the router.

    `guest_scan_limit_per_day <= 0` turns the feature off at admission time, so
    an operator's opt-out reads as 401 "no credential" rather than a 429 that
    implies a quota exists and will reset.
    """
    subject = await _session_subject(authorization, cookie, session)
    if subject is not None:
        return subject

    secret = (settings.better_auth_secret or "").strip()
    if settings.guest_scan_limit_per_day <= 0 or not secret or not guest_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized"
        )
    guest_id = _unwrap_guest_token(guest_token.strip(), secret)
    if guest_id is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized"
        )
    return f"guest:{guest_id}"


UserDep = Depends(require_user)
