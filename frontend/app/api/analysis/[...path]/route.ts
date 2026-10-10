import { NextRequest, NextResponse } from "next/server";
import { encodeAnalysisSegment } from "@/lib/analysis-api";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8000";

// `${BACKEND}/api/v1/analysis/<path>`, one encoded segment per path entry.
//
// The per-segment encoding is load-bearing, not decoration: `phone/{number}`
// puts the argument in the path, and Next has already run `decodeURIComponent`
// over each segment before this handler runs while re-escaping the delimiters
// it decoded (next/dist/server/lib/router-utils/decode-path-params.js). A `+`
// therefore arrives here as `+` and a `/` arrives as the literal `%2F`.
// `encodeURIComponent` alone would send `%2B` (right) but `%252F` (wrong — the
// backend decodes one layer and receives the text `%2F`); `encodeAnalysisSegment`
// is escape-aware, so the number survives the round trip intact.
function backendUrl(path: string[]): string {
  return `${BACKEND}/api/v1/analysis/${path.map(encodeAnalysisSegment).join("/")}`;
}

async function proxy(req: NextRequest, path: string[], body?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const cookie = req.headers.get("cookie");
  if (cookie) headers["cookie"] = cookie;
  const auth = req.headers.get("authorization");
  if (auth) headers["authorization"] = auth;
  try {
    const res = await fetch(backendUrl(path), {
      method: req.method,
      body,
      headers,
    });
    const text = await res.text();
    return new NextResponse(text, {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
    });
  } catch {
    return NextResponse.json({ detail: "The search service did not respond." }, { status: 502 });
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  return proxy(req, path);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const body = await req.text();
  return proxy(req, path, body);
}