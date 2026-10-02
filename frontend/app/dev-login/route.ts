import { createHmac } from "node:crypto";
import { NextResponse } from "next/server";

const DEFAULT_SECRET = "dev-secret-min-32-chars-change-me-xxxx";

function signSession(userId: string): string {
  const secret = process.env.BETTER_AUTH_SECRET ?? DEFAULT_SECRET;
  const payload = JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + 86400 });
  const encoded = Buffer.from(payload, "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(payload, "utf8").digest("hex");
  return `${encoded}.${signature}`;
}

export async function GET(req: Request) {
  if (process.env.NODE_ENV !== "development") {
    return new NextResponse("Not found", { status: 404 });
  }
  const res = NextResponse.redirect(new URL("/dashboard", req.url));
  res.cookies.set("better-auth.session_token", signSession("dev-user@local.test"), {
    path: "/",
    maxAge: 60 * 60 * 24,
    sameSite: "lax",
    httpOnly: true,
    secure: false,
  });
  return res;
}
