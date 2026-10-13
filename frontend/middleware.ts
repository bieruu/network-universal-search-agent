import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { contentSecurityPolicy, cspHeaderName, generateNonce } from "@/lib/csp";

/**
 * One body for every way this middleware can refuse to continue.
 *
 * These four branches used to return four different plain-text strings naming
 * the exact thing that broke — "Authentication is not configured", "URL must
 * use HTTPS in production", "URL is misconfigured", "Authentication service is
 * unavailable" — rendered raw into the browser. That hands an anonymous caller
 * a live map of which internal variable is unset. The branches stay (they are
 * still distinct code paths an operator needs); only the wording is unified.
 * The concrete reason is still available to operators in the server log.
 */
const UNAVAILABLE_BODY =
  "Sign-in is temporarily unavailable. Please try again in a few minutes.";

function unavailable(): NextResponse {
  return new NextResponse(UNAVAILABLE_BODY, {
    status: 503,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function redirectToSignIn(req: NextRequest): NextResponse {
  const url = req.nextUrl.clone();
  url.pathname = "/sign-in";
  return NextResponse.redirect(url);
}

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

  // Response side. Every response that leaves here — the redirect and the 503
  // included — carries the policy, otherwise a refused request would render
  // without a CSP at all. `x-nonce` deliberately does NOT go out: it is only
  // meaningful server-side, and echoing it to the browser would advertise the
  // value an attacker needs to forge for the next request.
  const send = (response: NextResponse) => {
    response.headers.set(headerName, policy);
    return response;
  };
  const forward = () => send(NextResponse.next({ request: { headers: requestHeaders } }));

  const authBaseURL = process.env.BETTER_AUTH_URL;
  if (!authBaseURL) {
    console.error("BETTER_AUTH_URL is not set; refusing to serve protected routes.");
    return send(unavailable());
  }

  // Production auth must ride on TLS; fail closed on plain http.
  // Localhost stays exempt so `npm run build && npm start` works without TLS.
  if (isProduction) {
    try {
      const url = new URL(authBaseURL);
      const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
      if (url.protocol !== "https:" && !local) {
        console.error("BETTER_AUTH_URL is not https in production; refusing to serve protected routes.");
        return send(unavailable());
      }
    } catch {
      console.error("BETTER_AUTH_URL is not a valid URL; refusing to serve protected routes.");
      return send(unavailable());
    }
  }

  // The session lookup is only needed behind the dashboard gate. `api/` is
  // already gated by the backend's `require_user`, and the public pages have
  // no session to look up, so a blanket fetch here would spend one round trip
  // to the auth server on every asset-adjacent request the matcher reaches.
  if (req.nextUrl.pathname.startsWith("/dashboard")) {
    try {
      const response = await fetch(new URL("/api/auth/get-session", authBaseURL), {
        headers: { cookie: req.headers.get("cookie") ?? "" },
        cache: "no-store",
      });
      if (!response.ok) return send(redirectToSignIn(req));

      const session = await response.json();
      if (session?.session && session?.user) return forward();
      return send(redirectToSignIn(req));
    } catch {
      // The cause (DNS, connection refused, timeout) stays in the server log;
      // the caller gets the same sentence as every other outage here.
      console.error("Could not reach the session endpoint; refusing to serve protected routes.");
      return send(unavailable());
    }
  }

  return forward();
}

export const config = {
  matcher: [
    // Pages only. The CSP nonce has to be minted wherever a document renders,
    // so this is wider than the dashboard gate. Excluded: `api/` (JSON proxies,
    // gated by the backend's require_user), `_next/` (no document, no inline
    // scripts) and the root favicon.
    "/((?!api/|_next/|favicon.ico).*)",
  ],
};
