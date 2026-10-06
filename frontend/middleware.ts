import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export async function middleware(req: NextRequest) {
  const authBaseURL = process.env.BETTER_AUTH_URL;
  if (!authBaseURL) {
    return new NextResponse("Authentication is not configured", { status: 503 });
  }

  // Production auth must ride on TLS; fail closed on plain http.
  // Localhost stays exempt so `npm run build && npm start` works without TLS.
  if (process.env.NODE_ENV === "production") {
    try {
      const url = new URL(authBaseURL);
      const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
      if (url.protocol !== "https:" && !local) {
        return new NextResponse("Authentication URL must use HTTPS in production", {
          status: 503,
        });
      }
    } catch {
      return new NextResponse("Authentication URL is misconfigured", { status: 503 });
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
    return new NextResponse("Authentication service is unavailable", { status: 503 });
  }
}

export const config = { matcher: ["/dashboard/:path*"] };
