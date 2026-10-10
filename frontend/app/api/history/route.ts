import { NextRequest, NextResponse } from "next/server";
import { messageForStatus } from "@/lib/user-errors";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8000";

export async function GET(req: NextRequest) {
  const search = req.nextUrl.search ?? "";
  const headers: Record<string, string> = {};
  const cookie = req.headers.get("cookie");
  if (cookie) headers["cookie"] = cookie;
  try {
    const res = await fetch(`${BACKEND}/api/v1/history${search}`, { headers });
    const text = await res.text();
    return new NextResponse(text, {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  } catch {
    // Never fabricate `{items: [], total: 0}` here. An empty list means "this
    // account has no scans"; returning that shape for a failed request makes a
    // dead backend indistinguishable from a new account, and the dashboard
    // renders it as the friendly "No scans yet" empty state. Propagate a real
    // failure instead — `lib/api.ts` maps the status to a sentence the UI shows.
    return NextResponse.json({ error: messageForStatus(502) }, { status: 502 });
  }
}
