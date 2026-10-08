"""Redirect chain trace: one hop-by-hop report of what a target actually served.

The SSRF guard (`app/core/ssrf.py`) already does the hard part, and it does it
strictly better than anything this module could build: it re-resolves and
re-checks **every** hop, pins the socket to the address it just validated, and
refuses a chain longer than `settings.fetch_max_redirects`. So this module
fetches nothing on its own. It calls `SafeFetcher.fetch()` and reads
`FetchResult.hops`, which already holds one `Hop` per request the guard actually
made — status, the IP dialled for *that* hop, and the raw `Location` that was
followed.

Reporting only the final URL loses the two things a reader is actually looking
for: *where* the chain went (a redirect onto a different host is the interesting
part) and *how* it got there (301 vs 307 vs 308 decides whether a follow-on tool
may replay the request). Both are per-hop facts, so both are reported per hop.

What this module adds on top of the guard's data is the reading: scheme changes,
downgrades back to plaintext, a URL that repeats (a loop the guard survived only
because it stayed under the cap), and the final status. Every string is bounded.
None of this verifies anything about the target: a redirect chain is a map of
what a server advertises.

Scope is deliberately one observation of one chain — no timing, no TLS detail, no
header dump, no body analysis, no retry, no crawl.

Failure policy (AGENTS.md §4, §5, §7 — fail closed):

  - `SsrfTooManyRedirects` is a *finding*, not a failure. A chain longer than the
    cap is a fact about the target, so it comes back as a normal result with
    `truncated: True` and a note. A cap that raises a 500 is not a cap. The
    exception does not carry the hops the guard had already made, so the hop list
    comes back empty — and `notes` says so rather than papering over it.
  - `SsrfBlocked`, `SsrfTimeout` and httpx failures propagate untouched. A
    blocked hop is a policy decision and must surface as one; the caller turns it
    into `errors[]` (AGENTS.md §5: never 500 on source failure).

Note that `truncated` here means *the chain was cut short by the hop cap*, not
that a response body was cut short — the guard's body cap is irrelevant here
because this module never reads the body it is handed.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

from app.core.ssrf import Hop, SafeFetcher, SsrfTooManyRedirects

SOURCE = "Redirect trace"

# Every string that came off the wire is bounded here. A redirect target is
# attacker-chosen text, so it gets the same treatment as a banner.
_MAX_URL_CHARS = 2048
_MAX_LOCATION_CHARS = 512
_MAX_IP_CHARS = 45  # longest textual IPv6 form; the guard only ever hands us a
# public address, but the length bound is about payload size, not the address.
_MAX_NOTE_CHARS = 200
_MAX_NOTES = 10

# Defensive only. The guard makes at most `fetch_max_redirects + 1` requests
# before it raises, so a real chain cannot reach this; it exists so a longer one
# cannot turn into an unbounded payload.
_MAX_HOPS_REPORTED = 20


def _scheme(url: str) -> str:
    """`https`, `http`, or `""` when it is neither.

    A prefix test rather than a parse: the guard already accepted the URL and
    `httpx.URL` has normalised the scheme to lowercase, so this cannot misread
    one, and it cannot raise on a hop shape nobody expected.
    """
    lowered = url.lower()
    if lowered.startswith("https://"):
        return "https"
    if lowered.startswith("http://"):
        return "http"
    return ""


def _host(url: str) -> str:
    """Hostname of an absolute URL, or `""`. Never raises on a hop from the guard."""
    return urlsplit(url).hostname or ""


def _hop_row(hop: Hop) -> dict[str, Any]:
    """One hop, flattened for JSON.

    `url` stays in hostname form because that is what the guard recorded: it is
    the URL a reader recognises, and substituting the pinned IP here would leak
    our internal connection detail into the UI. `resolved_ip` is the address that
    was actually validated and dialled for this hop — public by construction,
    since a blocked address never reaches a `Hop` at all.
    """
    return {
        "url": hop.url[:_MAX_URL_CHARS],
        "status": int(hop.status),
        "resolved_ip": str(hop.ip)[:_MAX_IP_CHARS],
        "location": hop.location[:_MAX_LOCATION_CHARS] if hop.location else None,
        "is_redirect": bool(hop.is_redirect),
    }


def _cap_notes(notes: list[str]) -> list[str]:
    """Bound the note list, and say so when notes were dropped."""
    bounded = [note[:_MAX_NOTE_CHARS] for note in notes]
    if len(bounded) > _MAX_NOTES:
        dropped = len(bounded) - (_MAX_NOTES - 1)
        bounded = bounded[: _MAX_NOTES - 1] + [f"{dropped} further finding(s) omitted"]
    return bounded


def _describe(hops: tuple[Hop, ...], final_status: int) -> dict[str, Any]:
    """Read the chain: three flags plus the raw (uncapped) note list.

    Ordering of the notes is the ordering of what a reader should look at first:
    a downgrade back to plaintext, then other scheme changes, then a repeated URL
    (a loop the cap did not catch), then host changes, then the shape of the
    answer.
    """
    counts: dict[str, int] = {}
    for hop in hops:
        counts[hop.url] = counts.get(hop.url, 0) + 1

    # `position` is 1-based, so it is also the hop number used in the note text.
    transitions: list[tuple[int, str, str]] = []
    for position in range(2, len(hops) + 1):
        before = _scheme(hops[position - 2].url)
        after = _scheme(hops[position - 1].url)
        if before and after and before != after:
            transitions.append((position, before, after))

    downgrades = [t for t in transitions if t[1] == "https" and t[2] == "http"]
    upgrades = [t for t in transitions if not (t[1] == "https" and t[2] == "http")]

    notes: list[str] = []
    for position, before, after in downgrades:
        notes.append(f"chain crosses from {before} to {after} on hop {position}")
    for position, before, after in upgrades:
        notes.append(f"chain crosses from {before} to {after} on hop {position}")

    repeated = [(url, count) for url, count in counts.items() if count > 1]
    for url, count in repeated:
        notes.append(
            f"possible redirect loop: the same URL appears {count} times ({url})"
        )

    # A host change is reported once per new host, at the hop it first appears.
    reported_hosts: set[str] = set()
    previous_host = _host(hops[0].url) if hops else ""
    for position in range(2, len(hops) + 1):
        host = _host(hops[position - 1].url)
        if not host or host == previous_host:
            continue
        previous_host = host
        if host not in reported_hosts:
            reported_hosts.add(host)
            notes.append(f"hop {position} moves to a different host: {host}")

    if len(hops) <= 1:
        notes.append("no redirect; the target answered directly")
    if final_status >= 400:
        notes.append(f"final status {final_status}")

    return {
        "crosses_scheme": bool(transitions),
        # True only where the chain actually went https -> http. "any later hop
        # is plain http" would fire on a chain that started on http and stayed
        # there, which is not a downgrade, and would tell a reader something
        # untrue about a perfectly ordinary site.
        "downgrades_to_http": bool(downgrades),
        "loop_detected": bool(repeated),
        "notes": notes,
    }


def _capped_result(url: str, error: Exception) -> dict[str, Any]:
    """The hop-cap result: a finding about the target, rendered as a normal result.

    `final_url`/`final_status`/`hop_count` are sentinels, not observations, and
    `notes` says exactly that — an empty hop list next to a confident-looking
    `final_url` would be the dishonest version of this cap.
    """
    return {
        "source": SOURCE,
        "url": url[:_MAX_URL_CHARS],
        "final_url": "",
        "final_status": 0,
        "hop_count": 0,
        "truncated": True,
        "hops": [],
        "crosses_scheme": False,
        "downgrades_to_http": False,
        "loop_detected": False,
        "notes": _cap_notes(
            [
                f"redirect chain stopped at the guard's hop cap: {error}",
                (
                    "no hops reported: the guard raises before handing back the "
                    "hops it had already made"
                ),
            ]
        ),
    }


async def lookup(url: str, fetcher: SafeFetcher | None = None) -> dict[str, Any]:
    """Trace one redirect chain for `url` and return a JSON-serialisable report.

    `url` must be a full URL; normalising a bare domain is the router's job, not
    this module's. Pass a `SafeFetcher` when the caller already has one (the
    router shares a fetcher across capabilities so the chain is traced once); when
    omitted, one is built here and closed before returning. An injected fetcher is
    never closed by this function.

    Raises `SsrfBlocked`, `SsrfTimeout` or the httpx error underneath for every
    failure except the hop cap, which is reported as `truncated: True`.
    """
    own_fetcher = fetcher is None
    active = SafeFetcher() if fetcher is None else fetcher
    try:
        try:
            result = await active.fetch(url)
        except SsrfTooManyRedirects as e:
            return _capped_result(url, e)
    finally:
        if own_fetcher:
            await active.aclose()

    hops = result.hops
    described = _describe(hops, result.status)

    notes = list(described["notes"])
    if len(hops) > _MAX_HOPS_REPORTED:
        notes.insert(
            0,
            f"chain is {len(hops)} hops long; only the first {_MAX_HOPS_REPORTED} "
            "are shown",
        )

    return {
        "source": SOURCE,
        "url": url[:_MAX_URL_CHARS],
        "final_url": result.final_url[:_MAX_URL_CHARS],
        "final_status": int(result.status),
        # Requests made minus the first: the number of *redirects*. Taken from the
        # full chain, not the reported rows, so the count stays truthful even if
        # the row cap above ever bites.
        "hop_count": max(len(hops) - 1, 0),
        "truncated": False,
        "hops": [_hop_row(hop) for hop in hops[:_MAX_HOPS_REPORTED]],
        "crosses_scheme": bool(described["crosses_scheme"]),
        "downgrades_to_http": bool(described["downgrades_to_http"]),
        "loop_detected": bool(described["loop_detected"]),
        "notes": _cap_notes(notes),
    }
