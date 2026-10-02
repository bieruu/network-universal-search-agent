import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const SESSION_COOKIE_NAME = "better-auth.session_token";
const DEFAULT_SECRET = "dev-secret-min-32-chars-change-me-xxxx";

function parseCookie(raw: string | undefined, name: string): string | undefined {
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const [cookieName, ...rest] = part.trim().split("=");
    if (cookieName === name) {
      return rest.join("=");
    }
  }
  return undefined;
}

function verifySessionCookie(rawToken: string | undefined): boolean {
  const secret = process.env.BETTER_AUTH_SECRET ?? process.env.NEXT_PUBLIC_BETTER_AUTH_SECRET ?? DEFAULT_SECRET;
  if (!rawToken || !rawToken.includes(".")) return false;
  const [payloadB64, signature] = rawToken.split(".");
  if (!payloadB64 || !signature) return false;
  try {
    const payloadBytes = Buffer.from(payloadB64.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (payloadB64.length % 4)) % 4), "base64");
    const payload = JSON.parse(payloadBytes.toString("utf8"));
    if (typeof payload?.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) return false;
    if (typeof payload?.sub !== "string" || !payload.sub.trim()) return false;
    const expected = createHmac("sha256", secret).update(payloadBytes).digest("hex");
    const actual = Buffer.from(signature, "hex");
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (!pathname.startsWith("/dashboard")) return NextResponse.next();
  const cookieHeader = req.headers.get("cookie") ?? "";
  const session = parseCookie(cookieHeader, SESSION_COOKIE_NAME) ?? parseCookie(cookieHeader, "__Secure-better-auth.session_token");
  if (!session || !verifySessionCookie(session)) {
    const url = req.nextUrl.clone();
    url.pathname = "/sign-in";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ["/dashboard/:path*"] };
