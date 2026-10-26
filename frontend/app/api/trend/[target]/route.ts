import { NextRequest, NextResponse } from "next/server";
import { isTimeoutAbort, timedOut, upstreamSignal } from "@/lib/proxy-timeout";
import { messageForStatus } from "@/lib/user-errors";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8000";

// Vercel's Hobby ceiling. The upstream budget (PROXY_UPSTREAM_TIMEOUT_MS, 45s)
// sits below it on purpose, so this function answers first with a parseable 504
// instead of the platform killing the request at 60s.
export const maxDuration = 60;

export async function GET(req: NextRequest, { params }: { params: Promise<{ target: string }> }) {
  const { target } = await params;
  const headers: Record<string, string> = {};
  const cookie = req.headers.get("cookie");
  if (cookie) headers["cookie"] = cookie;
  try {
    const res = await fetch(
      `${BACKEND}/api/v1/target/${encodeURIComponent(target)}/trend`,
      { headers, signal: upstreamSignal() },
    );
    const text = await res.text();
    return new NextResponse(text, {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    // A fabricated `{points: []}` reads as "this target has never been scanned",
    // which is a false clean bill of health. Propagate the failure and let the
    // chart say it could not load - see RiskTrendChartInner. A timeout is the
    // service being reachable but slow (usually waking up): 504. Anything else
    // is 502. `handle()` reads the status, not the body shape.
    if (isTimeoutAbort(error)) return timedOut();
    return NextResponse.json({ error: messageForStatus(502) }, { status: 502 });
  }
}
