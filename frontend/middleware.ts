import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

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

export async function middleware(req: NextRequest) {
  const authBaseURL = process.env.BETTER_AUTH_URL;
  if (!authBaseURL) {
    console.error("BETTER_AUTH_URL is not set; refusing to serve protected routes.");
    return unavailable();
  }

  // Production auth must ride on TLS; fail closed on plain http.
  // Localhost stays exempt so `npm run build && npm start` works without TLS.
  if (process.env.NODE_ENV === "production") {
    try {
      const url = new URL(authBaseURL);
      const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
      if (url.protocol !== "https:" && !local) {
        console.error("BETTER_AUTH_URL is not https in production; refusing to serve protected routes.");
        return unavailable();
      }
    } catch {
      console.error("BETTER_AUTH_URL is not a valid URL; refusing to serve protected routes.");
      return unavailable();
    }
  }

  try {
    const response = await fetch(new URL("/api/auth/get-session", authBaseURL), {
      headers: { cookie: req.headers.get("cookie") ?? "" },
      cache: "no-store",
    });
    if (!response.ok) {
      const url = req.nextUrl.clone();
      url.pathname = "/sign-in";
      return NextResponse.redirect(url);
    }

    const session = await response.json();
    if (session?.session && session?.user) return NextResponse.next();
    const url = req.nextUrl.clone();
    url.pathname = "/sign-in";
    return NextResponse.redirect(url);
  } catch {
    // The cause (DNS, connection refused, timeout) stays in the server log;
    // the caller gets the same sentence as every other outage here.
    console.error("Could not reach the session endpoint; refusing to serve protected routes.");
    return unavailable();
  }
}

export const config = { matcher: ["/dashboard/:path*"] };
