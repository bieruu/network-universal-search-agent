import { NextRequest, NextResponse } from "next/server";

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
    return NextResponse.json({ items: [], total: 0 }, { status: 502 });
  }
}
