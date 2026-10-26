import { NextRequest, NextResponse } from "next/server";
import { collectBounded, declaredTooLarge, PayloadTooLargeError, PROXY_MAX_BODY_BYTES, requestBodyChunks } from "@/lib/proxy-body";
import { encodeAnalysisSegment } from "@/lib/analysis-api";
import { isTimeoutAbort, timedOut, upstreamSignal } from "@/lib/proxy-timeout";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8000";

// Vercel's Hobby ceiling. The upstream budget (PROXY_UPSTREAM_TIMEOUT_MS, 45s)
// sits below it on purpose, so this function answers first with a parseable 504
// instead of the platform killing the request at 60s.
export const maxDuration = 60;

// `${BACKEND}/api/v1/analysis/<path>`, one encoded segment per path entry.
//
// The per-segment encoding is load-bearing, not decoration: `phone/{number}`
// puts the argument in the path, and Next has already run `decodeURIComponent`
// over each segment before this handler runs while re-escaping the delimiters
// it decoded (next/dist/server/lib/router-utils/decode-path-params.js). A `+`
// therefore arrives here as `+` and a `/` arrives as the literal `%2F`.
// `encodeURIComponent` alone would send `%2B` (right) but `%252F` (wrong - the
// backend decodes one layer and receives the text `%2F`); `encodeAnalysisSegment`
// is escape-aware, so the number survives the round trip intact.
function backendUrl(path: string[]): string {
  return `${BACKEND}/api/v1/analysis/${path.map(encodeAnalysisSegment).join("/")}`;
}

function tooLarge(): NextResponse {
  return NextResponse.json(
    {
      detail:
        `Request body is too large (limit ${PROXY_MAX_BODY_BYTES} bytes). ` +
        "Send a smaller request.",
    },
    { status: 413 },
  );
}

/**
 * Read the body under the size cap, or `null` when it was already refused.
 *
 * Same reasoning as the scan proxy, and it matters more here: `POST
 * /analysis/exif` is the one endpoint whose legitimate payload is measured in
 * megabytes, so it is also the one an oversized upload would be pointed at.
 * `middleware.ts` matches only `/dashboard/:path*`, so nothing on this side of
 * the wire refuses a request before the body is read.
 */
async function readBody(req: NextRequest): Promise<string | null> {
  if (declaredTooLarge((name) => req.headers.get(name))) return null;
  try {
    return await collectBounded(requestBodyChunks(req.body));
  } catch (error) {
    if (error instanceof PayloadTooLargeError) return null;
    throw error;
  }
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
      signal: upstreamSignal(),
    });
    const text = await res.text();
    return new NextResponse(text, {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
    });
  } catch (error) {
    // Reachable but silent past the budget (usually a cold start) is a 504; a
    // refused connection or DNS failure is not, and stays the existing 502.
    if (isTimeoutAbort(error)) return timedOut();
    return NextResponse.json({ detail: "The search service did not respond." }, { status: 502 });
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  return proxy(req, path);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const body = await readBody(req);
  if (body === null) return tooLarge();
  return proxy(req, path, body);
}