/**
 * The deadline every API proxy shares, and the two shapes a failure takes.
 *
 * WHY 55 SECONDS
 *     It is a legibility budget, not a guarantee that every warm scan fits.
 *     Read the orchestrator rather than the per-source timeouts:
 *     `gather_results` does gather its primary sources concurrently, but two
 *     chains around that fan-out are SEQUENTIAL. After crt.sh fails it runs
 *     Cert Spotter (18s) then Subfinder (10s) one after the other, so the
 *     gather phase costs 58s at the code defaults (30+18+10) and 43s with the
 *     shipped `SCAN_TIMEOUT_CRTSH=15` - the orchestrator's own docstring states
 *     that 58s. The post-gather tail is sequential too: NVD enrichment walks
 *     up to five CPEs, then per-CVE lookups, then the OTX/URLScan/Leak-Lookup
 *     history chain. And `POST /api/v1/scan` is synchronous
 *     (`routers/scan.py: await orchestrator.run_scan(...)`), so this budget
 *     bounds a whole scan, not a probe.
 *
 *     55s is the largest useful budget under the 60s ceiling these routes
 *     declare (`export const maxDuration = 60`): it covers the 43s
 *     shipped-config certificate chain with slack, and leaves roughly 5s for
 *     Vercel to receive and serialize the 504 instead of killing the request
 *     at 60s and sending an HTML error page the client cannot parse.
 *
 *     It does NOT guarantee a fit for the 58s code-default chain (a
 *     `SCAN_TIMEOUT_CRTSH` of 30) or the sequential NVD tail. No value under
 *     the 60s ceiling can: a budget that covered 58s plus the tail would have
 *     to exceed the ceiling, which just moves the opaque edge kill back. So a
 *     healthy-but-slow scan can still receive this 504, and the copy must not
 *     present a single cause as fact - it can be a cold start OR the search
 *     itself running long. Shrinking the sequential fallback chain is the
 *     actual fix; this budget only makes the failure legible until then.
 *
 * WHY `Response.json` AND NOT `NextResponse.json`
 *     A route handler may return any `Response`; `Response.json` produces the
 *     same `content-type: application/json` body. Avoiding the `next/server`
 *     import keeps this module runnable directly by `node --test`, the same
 *     reason `lib/proxy-body.ts` has no Next imports - its own tests exercise
 *     it without the framework.
 */

export const PROXY_UPSTREAM_TIMEOUT_MS = 55_000;

/**
 * The signal to hand `fetch`. `AbortSignal.timeout` rejects the fetch with a
 * `DOMException` named "TimeoutError" once the budget is spent, which is what
 * {@link isTimeoutAbort} recognises.
 */
export function upstreamSignal(): AbortSignal {
  return AbortSignal.timeout(PROXY_UPSTREAM_TIMEOUT_MS);
}

/**
 * True when the fetch was killed by this proxy's deadline, rather than by the
 * network refusing the connection.
 *
 * `AbortSignal.timeout` rejects with a `DOMException` whose name is
 * "TimeoutError"; an explicit `AbortController.abort()` uses "AbortError".
 * Both mean "the deadline passed", so both map to 504. A refused connection or
 * a DNS failure arrives as a `TypeError` ("fetch failed") and must stay 502 -
 * the service is not reachable at all, which is a different fact for the user.
 *
 * The non-DOMException fallback is for runtimes that surface the abort as a
 * plain `Error` that kept the name but not the class; the name is the part the
 * abort contract actually guarantees.
 */
export function isTimeoutAbort(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === "TimeoutError" || error.name === "AbortError";
  }
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

/**
 * The 504 this proxy sends itself: the fact it can establish, both plausible
 * causes as possibilities rather than one asserted, and the next action.
 * Without exposing the backend URL or the constant as an internals dump.
 */
export function timedOut(): Response {
  const seconds = Math.round(PROXY_UPSTREAM_TIMEOUT_MS / 1000);
  return Response.json(
    {
      detail:
        `The search service did not answer within ${seconds} seconds. ` +
        "It may still be starting up, or the search itself may be taking longer " +
        "than usual - wait about a minute and try again.",
    },
    { status: 504 },
  );
}
