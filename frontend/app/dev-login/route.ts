import { NextResponse } from "next/server";

// Dev-only auto-login. The auth stub creates no real session, so local dev
// needs a shortcut: this sets the stub session cookie and bounces to
// /dashboard. NEVER reachable outside `next dev` (NODE_ENV guard below,
// no link to this route anywhere in the UI).
export async function GET(req: Request) {
  if (process.env.NODE_ENV !== "development") {
    return new NextResponse("Not found", { status: 404 });
  }
  const res = NextResponse.redirect(new URL("/dashboard", req.url));
  res.cookies.set("better-auth.session_token", "dev", {
    path: "/",
    maxAge: 60 * 60 * 24,
    sameSite: "lax",
  });
  return res;
}
