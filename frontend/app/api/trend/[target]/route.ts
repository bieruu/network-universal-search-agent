import { NextRequest, NextResponse } from "next/server";
import { messageForStatus } from "@/lib/user-errors";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8000";

export async function GET(req: NextRequest, { params }: { params: Promise<{ target: string }> }) {
  const { target } = await params;
  const headers: Record<string, string> = {};
  const cookie = req.headers.get("cookie");
  if (cookie) headers["cookie"] = cookie;
  try {
    const res = await fetch(
      `${BACKEND}/api/v1/target/${encodeURIComponent(target)}/trend`,
      { headers },
    );
    const text = await res.text();
    return new NextResponse(text, {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  } catch {
    // A fabricated `{points: []}` reads as "this target has never been scanned",
    // which is a false clean bill of health. Propagate the failure and let the
    // chart say it could not load — see RiskTrendChartInner.
    return NextResponse.json({ error: messageForStatus(502) }, { status: 502 });
  }
}
