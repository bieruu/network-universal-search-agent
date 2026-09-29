import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Better Auth guard stub: require session cookie, else redirect to /sign-in.
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const protected_ =
    pathname.startsWith("/dashboard");
  if (!protected_) return NextResponse.next();
  const session =
    req.cookies.get("better-auth.session_token") ??
    req.cookies.get("__Secure-better-auth.session_token");
  if (!session) {
    const url = req.nextUrl.clone();
    url.pathname = "/sign-in";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*"],
};
