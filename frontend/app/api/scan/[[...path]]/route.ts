import { NextRequest, NextResponse } from "next/server";
import { collectBounded, declaredTooLarge, PayloadTooLargeError, PROXY_MAX_BODY_BYTES, requestBodyChunks } from "@/lib/proxy-body";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8000";

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

function backendUrl(path: string[]): string {
  return `${BACKEND}/api/v1/scan${path.length ? "/" + path.map(encodeURIComponent).join("/") : ""}`;
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
      headers,
      body,
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

/**
 * Read the body under the size cap, or `null` when it was already refused.
 *
 * The 413 is answered here, before any byte of the body is read, whenever the
 * client declared an oversized Content-Length. Otherwise the body is streamed
 * through `collectBounded`, which stops the moment it crosses the cap and
 * cancels the upload. Reading unboundedly with `req.text()` was a memory
 * exhaustion path for an anonymous caller: `middleware.ts` does not cover
 * `/api/*`, so nothing on this side says no before the read.
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

export async function GET(req: NextRequest, { params }: { params: Promise<{ path?: string[] }> }) {
  const { path } = await params;
  return proxy(req, path ?? []);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ path?: string[] }> }) {
  const { path } = await params;
  const body = await readBody(req);
  if (body === null) return tooLarge();
  return proxy(req, path ?? [], body);
}
