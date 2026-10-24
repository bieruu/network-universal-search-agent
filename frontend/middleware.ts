import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { contentSecurityPolicy, cspHeaderName, generateNonce } from "@/lib/csp";

/**
 * CSP + nonce only. This middleware used to carry three auth jobs as well -
 * a session lookup behind `/dashboard`, a redirect to `/sign-in` when it found
 * none, and a 503 whenever `BETTER_AUTH_URL` was unset or not https in
 * production. All three were removed on 2026-10-14 by the operator-approved
 * guest-scan reversal (see DESIGN.md for the dated note):
 *
 *   * The redirect is gone because a signed-out visitor is a supported
 *     visitor now: `/dashboard` renders in guest mode and scans against a
 *     quota (`require_user_or_guest` on the backend). Sending them to
 *     `/sign-in` was the very behaviour the reversal removed.
 *   * The 503 is gone because it fired on EVERY page, including `/`: an auth
 *     misconfiguration used to turn the landing page into the sentence
 *     "Sign-in is temporarily unavailable." The landing page has nothing to do
 *     with auth availability, so it must never be able to fail that way.
 *   * The session lookup is gone because nothing here acts on the answer.
 *
 * Authorization did not move out of the app - it is where it always belonged:
 * the backend gates every endpoint (`require_user`, and
 * `require_user_or_guest` on the two scan routes), so a rendered shell without
 * a session can read no data it is not allowed to ask for. What is given up is
 * the fail-closed HTML gate: the dashboard document now renders for anyone and
 * gets its 401s from the API, which is the honest place for them.
 */
export async function middleware(req: NextRequest) {
  const isProduction = process.env.NODE_ENV === "production";

  // One nonce per request, never reused. Next reads it back out of the
  // *request* CSP header (`get-script-nonce-from-header.js`) and stamps it on
  // every inline script it emits, so the policy below is the only thing the
  // browser will allow to run.
  const nonce = generateNonce();
  const policy = contentSecurityPolicy(nonce);
  const headerName = cspHeaderName(isProduction);

  // Request side. `content-security-policy` is the channel Next itself reads;
  // `x-nonce` is the app's own channel, consumed by `app/layout.tsx` through
  // `next/headers`. Both are stripped from what the caller sees.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", policy);

  // Response side. Every response that leaves here carries the policy, so a
  // document is never served without one - including the documents that used
  // to be answered by the removed 503. `x-nonce` deliberately does NOT go out:
  // it is only meaningful server-side, and echoing it to the browser would
  // advertise the value an attacker needs to forge for the next request.
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(headerName, policy);
  return response;
}

export const config = {
  matcher: [
    // Pages only. The CSP nonce has to be minted wherever a document renders,
    // so this is wider than any single route. Excluded: `api/` (JSON proxies,
    // gated by the backend's require_user / require_user_or_guest), `_next/`
    // (no document, no inline scripts) and the root favicon.
    "/((?!api/|_next/|favicon.ico).*)",
  ],
};
