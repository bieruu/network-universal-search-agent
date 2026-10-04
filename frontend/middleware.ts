import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export async function middleware(req: NextRequest) {
  const authBaseURL = process.env.BETTER_AUTH_URL;
  if (!authBaseURL) {
    return new NextResponse("Authentication is not configured", { status: 503 });
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
