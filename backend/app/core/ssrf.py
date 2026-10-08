"""SSRF guard: the only sanctioned way for the backend to fetch a target URL.

The existing `assert_target_allowed` / `assert_resolved_target_allowed` checks are
a *string* check plus one resolution of the name the user typed. That is enough
for a target we only ever look up in Shodan/crt.sh/WHOIS. It is not enough for a
module that makes the backend *connect* to a target, because the connection
follows a path the initial check never sees:

  - a 302 to `http://169.254.169.254/latest/meta-data/` (cloud metadata), or
  - a 302 to `http://localhost:5432/`, or
  - a public name that resolves to 127.0.0.1 *at connect time* but resolved to a
    public IP when we checked it (DNS rebinding),
  - `http://2130706433/`, which glibc's resolver reads as 127.0.0.1.

So every fetch in this repo goes through `SafeFetcher`, which makes four
guarantees the string check cannot:

  1. Only `http`/`https`, and only a URL that carries no userinfo.
  2. **Every** address the name resolves to is re-checked before the connection,
     and the request is then sent to a pinned IP literal with the original
     `Host` header and SNI restored. Pinning is what closes the rebinding gap:
     the socket cannot end up somewhere the check did not approve, because the
     address we validated is the address we dialled. It also means the
     alternative forms (decimal, octal, IPv4-mapped IPv6, `0.0.0.0`) are
     normalised by the resolver first and judged as the IP they actually are,
     rather than as the string the user typed.
  3. Redirects are followed **manually**, one hop at a time, and each hop goes
     back through step 1 and 2. httpx never gets `follow_redirects=True` for a
     target fetch, because a redirect it follows on its own is a redirect we did
     not validate.
  4. Response bytes are capped while streaming, so a hostile origin cannot stream
     until the worker dies. The client is also built with `trust_env=False`:
     with the default, an `HTTP_PROXY` in the environment would silently move
     the connection off the pinned IP and undo all of the above.

Failure is an exception, never a silent partial: a blocked hop is a policy
decision and must surface as such, and callers translate it (see
`routers/analysis.py`).

No active scanning, no port probing, and no request body: this module exists to
let us *read* what a target already serves publicly, never to interact with it
(AGENTS.md §7).
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from dataclasses import dataclass
from typing import Self
from urllib.parse import urljoin

import httpx

from app.core.config import settings
from app.core.security import is_blocked_target

_ALLOWED_SCHEMES = frozenset({"http", "https"})
_DEFAULT_PORTS = {"http": 80, "https": 443}
# Statuses that carry a Location we might chase. Anything else with a Location
# header is not a redirect and is returned to the caller as the final response.
_REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})
_MAX_URL_LENGTH = 2048
_MAX_LOCATION_LENGTH = 512
_USER_AGENT = "osint-dashboard/1.0"


class SsrfError(RuntimeError):
    """Base class so callers can catch every policy failure in one place."""


class SsrfBlocked(SsrfError):
    """The URL is not fetchable at all: bad scheme, or a blocked address."""


class SsrfTooManyRedirects(SsrfError):
    """The chain exceeded `settings.fetch_max_redirects`."""


class SsrfTimeout(SsrfError):
    """A hop did not answer inside `settings.fetch_timeout_seconds`."""


@dataclass(frozen=True)
class Hop:
    """One request the guard actually made.

    `url` is the URL as the user would recognise it (hostname intact, not the
    pinned IP), so a caller showing a redirect chain is not leaking our internal
    IP pinning into the UI.
    """

    url: str
    status: int
    ip: str
    location: str | None
    is_redirect: bool


@dataclass(frozen=True)
class FetchResult:
    requested_url: str
    final_url: str
    status: int
    ip: str
    # httpx.Headers, not a dict: a plain dict collapses repeated names, and the
    # one header that must not be collapsed is Set-Cookie. Callers that need the
    # repeats use .get_list("set-cookie"); callers that do not can treat it like
    # a mapping, because it is a case-insensitive one.
    headers: httpx.Headers
    content: bytes
    truncated: bool
    hops: tuple[Hop, ...]

    @property
    def redirect_count(self) -> int:
        return sum(1 for hop in self.hops if hop.is_redirect)

    def text(self, limit: int | None = None) -> str:
        """Decode the captured body for inspection, tolerating bad encodings."""
        raw = self.content if limit is None else self.content[:limit]
        return raw.decode("utf-8", errors="replace")


def _sync_resolve_all(host: str, port: int) -> list[str]:
    """Blocking resolver body. Only ever reached through asyncio.to_thread.

    `getaddrinfo` rather than `gethostbyname` because the latter is IPv4-only and
    would silently hide an AAAA record pointing at loopback. Returns every
    address, deduped in order: the caller rejects the name if *any* one of them
    is blocked, so that a name with one public and one private answer cannot be
    used to smuggle us onto the private one.
    """
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    seen: dict[str, None] = {}
    for info in infos:
        address = info[4][0]
        if address:
            seen.setdefault(address, None)
    return list(seen)


async def validate_host(host: str, port: int = 443) -> list[str]:
    """Resolve `host:port` and refuse unless every answer is publicly routable.

    The public seam for anything that opens its own socket to a target rather
    than going through `SafeFetcher` — a TLS handshake, for example, which
    `SafeFetcher` does not perform. Same guarantee, same fail-closed policy: it
    returns the validated addresses so the caller can pin to one, and raises
    `SsrfBlocked` on a resolver failure, an empty answer, or any blocked answer.

    Being handed a validated address list is the whole point: the caller must
    then *dial that address*, not re-resolve the name, or the check is decorative.
    """
    try:
        addresses = await asyncio.to_thread(_sync_resolve_all, host, port)
    except (OSError, asyncio.TimeoutError) as e:
        raise SsrfBlocked(f"{host}: could not be resolved") from e

    if not addresses:
        raise SsrfBlocked(f"{host}: did not resolve to any address")

    for address in addresses:
        if is_blocked_target(address):
            raise SsrfBlocked(f"{host}: resolves to a blocked address ({address})")
    return addresses


async def _resolve_and_check(url: httpx.URL) -> list[str]:
    """Resolve the URL's host and reject the URL unless every answer is public."""
    return await validate_host(url.host, url.port or _DEFAULT_PORTS[url.scheme])


def _check_url(raw: str) -> httpx.URL:
    """Reject anything we will not or cannot fetch, before any DNS work."""
    if len(raw) > _MAX_URL_LENGTH:
        raise SsrfBlocked("URL is too long")

    try:
        url = httpx.URL(raw)
    except httpx.InvalidURL as e:
        raise SsrfBlocked("Malformed URL") from e

    if url.scheme not in _ALLOWED_SCHEMES:
        raise SsrfBlocked("Only http and https URLs can be fetched")
    # `http://expected-host@evil-host/` is read by some clients as userinfo and
    # by others as the host. Refusing userinfo removes the ambiguity instead of
    # picking one reading.
    if url.userinfo:
        raise SsrfBlocked("URLs with embedded credentials are not fetched")
    if not url.host:
        raise SsrfBlocked("URL has no host")
    return url


def _pinned(url: httpx.URL, address: str) -> httpx.URL:
    """Rewrite the URL to dial `address` directly."""
    return url.copy_with(host=address)


def _host_header(url: httpx.URL) -> str:
    """Rebuild the Host header for the pinned request.

    httpx derives Host from the URL, which now holds an IP literal, so the
    original authority has to be restored explicitly or the target sees a Host
    of `1.2.3.4` and 400s instead of serving.
    """
    default = _DEFAULT_PORTS[url.scheme]
    if url.port is None or url.port == default:
        return url.host
    if ":" in url.host:  # IPv6 literal needs brackets in an authority
        return f"[{url.host}]:{url.port}"
    return f"{url.host}:{url.port}"


class SafeFetcher:
    """Fetches a target URL with every hop validated and every body capped.

    Use as an async context manager so the underlying client is closed:

        async with SafeFetcher() as fetcher:
            result = await fetcher.fetch("https://example.com")

    The client is created here rather than injected so `trust_env=False` and
    `follow_redirects=False` cannot be forgotten by a caller. Tests may still
    inject their own client (that is how they point at a mock transport).
    """

    def __init__(
        self,
        client: httpx.AsyncClient | None = None,
        *,
        max_redirects: int | None = None,
        max_bytes: int | None = None,
        timeout: float | None = None,
    ) -> None:
        self._client = client
        self._owns_client = client is None
        self._max_redirects = (
            settings.fetch_max_redirects if max_redirects is None else max_redirects
        )
        self._max_bytes = settings.fetch_max_bytes if max_bytes is None else max_bytes
        self._timeout = (
            float(settings.fetch_timeout_seconds) if timeout is None else timeout
        )

    async def __aenter__(self) -> Self:
        self._ensure_client()
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    def _ensure_client(self) -> None:
        """Build the client on first use, so the safe flags cannot be skipped.

        Called from both `__aenter__` and `_request`, so a caller that forgets
        the context manager still cannot end up with a client that trusts
        `HTTP_PROXY` or follows redirects on its own — it just leaks the client
        unless it closes the fetcher.
        """
        if self._client is None:
            self._client = httpx.AsyncClient(
                headers={"User-Agent": _USER_AGENT},
                # Both of these are load-bearing, not defaults we prefer:
                # trust_env would let HTTP_PROXY in the environment move the
                # connection off the pinned IP, and follow_redirects would let
                # httpx chase a Location we never validated.
                trust_env=False,
                follow_redirects=False,
                limits=httpx.Limits(max_connections=10),
            )

    async def aclose(self) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None

    async def _request(self, raw_url: str) -> tuple[httpx.URL, str, httpx.Response]:
        """Validate one hop and send it. Caller owns closing the response."""
        self._ensure_client()
        assert self._client is not None
        url = _check_url(raw_url)
        addresses = await _resolve_and_check(url)
        address = addresses[0]

        # SNI carries the hostname, not the IP: without it a TLS target sees a
        # certificate mismatch and every https fetch fails. Skipped for IP
        # literals, where SNI is meaningless.
        extensions = {} if _is_ip_literal(url.host) else {"sni_hostname": url.host}

        try:
            request = self._client.build_request(
                "GET",
                _pinned(url, address),
                headers={"Host": _host_header(url)},
                extensions=extensions,
                timeout=self._timeout,
            )
            response = await self._client.send(request, follow_redirects=False)
        except httpx.TimeoutException as e:
            raise SsrfTimeout(
                f"{url.host}: timed out after {self._timeout:.0f}s"
            ) from e
        return url, address, response

    async def fetch(self, raw_url: str) -> FetchResult:
        """Fetch `raw_url`, following redirects one validated hop at a time.

        Redirects are capped: `settings.fetch_max_redirects` hops, each of which
        costs a fresh resolution. A chain longer than that is either a loop or an
        attempt to burn the worker's time, so it raises rather than truncating
        quietly.
        """
        requested = raw_url
        hops: list[Hop] = []
        current = raw_url

        while True:
            if len(hops) > self._max_redirects:
                raise SsrfTooManyRedirects(
                    f"Redirect chain exceeded {self._max_redirects} hops"
                )

            url, address, response = await self._request(current)
            try:
                status = response.status_code
                location = response.headers.get("location")
                is_redirect = status in _REDIRECT_STATUSES and bool(location)

                hops.append(
                    Hop(
                        url=str(url),
                        status=status,
                        ip=address,
                        location=(
                            location[:_MAX_LOCATION_LENGTH] if location else None
                        ),
                        is_redirect=is_redirect,
                    )
                )

                if not is_redirect:
                    content, truncated = await self._read_capped(response)
                    return FetchResult(
                        requested_url=requested,
                        final_url=str(url),
                        status=status,
                        ip=address,
                        headers=response.headers,
                        content=content,
                        truncated=truncated,
                        hops=tuple(hops),
                    )

                # A redirect body is never needed, and reading it would hand a
                # hostile origin an unbounded download on every hop. The
                # response is closed by the `finally` below without being read.
                current = urljoin(str(url), location)
            finally:
                await response.aclose()

    async def _read_capped(self, response: httpx.Response) -> tuple[bytes, bool]:
        """Read at most `max_bytes`, stopping the stream the moment it is full."""
        if not hasattr(response, "stream"):
            raise SsrfError("Response is not a stream")
        buffer = bytearray()
        truncated = False
        async for chunk in response.aiter_bytes():
            room = self._max_bytes - len(buffer)
            if room <= 0:
                truncated = True
                break
            if len(chunk) > room:
                buffer.extend(chunk[:room])
                truncated = True
                break
            buffer.extend(chunk)
        return bytes(buffer), truncated


def _is_ip_literal(host: str) -> bool:
    candidate = host.strip("[]")
    try:
        ipaddress.ip_address(candidate)
    except ValueError:
        return False
    return True
