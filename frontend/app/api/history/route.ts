import { NextRequest, NextResponse } from "next/server";
import { isTimeoutAbort, timedOut, upstreamSignal } from "@/lib/proxy-timeout";
import { messageForStatus } from "@/lib/user-errors";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8000";

// Vercel's Hobby ceiling. The upstream budget (PROXY_UPSTREAM_TIMEOUT_MS, 45s)
// sits below it on purpose, so this function answers first with a parseable 504
// instead of the platform killing the request at 60s.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const search = req.nextUrl.search ?? "";
  const headers: Record<string, string> = {};
  const cookie = req.headers.get("cookie");
  if (cookie) headers["cookie"] = cookie;
  try {
    const res = await fetch(`${BACKEND}/api/v1/history${search}`, {
      headers,
      signal: upstreamSignal(),
    });
    const text = await res.text();
    return new NextResponse(text, {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    // Never fabricate `{items: [], total: 0}` here. An empty list means "this
    // account has no scans"; returning that shape for a failed request makes a
    // dead backend indistinguishable from a new account, and the dashboard
    // renders it as the friendly "No scans yet" empty state. Propagate a real
    // failure instead - `lib/api.ts` maps the status to a sentence the UI shows.
    //
    // Both branches do that; the difference is the story. A timeout means the
    // service was reachable but silent (usually still starting up), so it gets
    // the honest 504. A refused connection is still 502. `handle()` reads the
    // status, never the body shape, so `{detail}` vs `{error}` is safe here.
    if (isTimeoutAbort(error)) return timedOut();
    return NextResponse.json({ error: messageForStatus(502) }, { status: 502 });
  }
}
