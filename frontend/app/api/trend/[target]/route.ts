import { NextRequest, NextResponse } from "next/server";

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
    return NextResponse.json({ points: [] }, { status: 502 });
  }
}
