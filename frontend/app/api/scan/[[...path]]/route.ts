import { NextRequest, NextResponse } from "next/server";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { collectBounded, declaredTooLarge, PayloadTooLargeError, PROXY_MAX_BODY_BYTES, requestBodyChunks } from "@/lib/proxy-body";
import { isTimeoutAbort, timedOut, upstreamSignal } from "@/lib/proxy-timeout";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8000";

// Vercel's Hobby ceiling. The upstream budget (PROXY_UPSTREAM_TIMEOUT_MS, 45s)
// sits below it on purpose, so this function answers first with a parseable 504
// instead of the platform killing the request at 60s.
export const maxDuration = 60;

/**
 * Guest identity (reversal 2026-10-14: signed-out visitors can scan).
 *
 * The backend cannot bucket this traffic by IP - the caller it sees is always
 * this Node process, never the browser - so the identity is minted HERE and
 * handed over as `x-guest-token`: `<32-hex-id>.<unpadded base64url HMAC-SHA256>`
 * over `"nusa-guest:" + id`, keyed with the shared `BETTER_AUTH_SECRET`.
 *
 * Two rules make that safe to trust from the outside:
 *
 *   1. Only this process can mint one (it holds the secret), so a caller who
 *      hits the backend directly has no way to author a subject. The backend
 *      re-verifies the signature and the id shape (`app/core/security.py`) -
 *      this side is the minter, not the authority.
 *   2. What it does NOT prove is scarcity. Anyone can clear a cookie and buy a
 *      fresh id, which is why the backend pairs the per-guest quota with an
 *      instance-wide daily budget no cookie can reset. Do not present the
 *      cookie as a security boundary; it is a label with a budget behind it.
 *
 * The cookie is HttpOnly (a script cannot read or forge what it cannot see),
 * SameSite=Lax, 30 days, Secure in production.
 */
const GUEST_COOKIE = "nusa_guest";
const GUEST_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;
// Pinned against the backend, which rejects anything else before signing work
// happens: 16 random bytes as hex, and a 32-byte signature unpadded.
const GUEST_TOKEN_RE = /^[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/;

function guestSecret(): string | null {
  const secret = (process.env.BETTER_AUTH_SECRET ?? "").trim();
  return secret ? secret : null;
}

function signGuestId(guestId: string, secret: string): string {
  return createHmac("sha256", secret).update(`nusa-guest:${guestId}`).digest("base64url");
}

function mintGuestToken(secret: string): string {
  const guestId = randomBytes(16).toString("hex");
  return `${guestId}.${signGuestId(guestId, secret)}`;
}

/** The stored cookie, re-verified here rather than trusted because it exists. */
function validGuestToken(value: string | undefined, secret: string | null): string | null {
  if (!value || !secret || !GUEST_TOKEN_RE.test(value)) return null;
  const guestId = value.slice(0, 32);
  const signature = Buffer.from(value.slice(33), "utf8");
  const expected = Buffer.from(signGuestId(guestId, secret), "utf8");
  if (signature.length !== expected.length) return null;
  return timingSafeEqual(signature, expected) ? value : null;
}

function guestCookie(token: string): string {
  const parts = [
    `${GUEST_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${GUEST_COOKIE_MAX_AGE}`,
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

interface GuestIdentity {
  /** Value for the `x-guest-token` request header, or `null` when there is none. */
  token: string | null;
  /** Set-Cookie for this response, when a fresh identity was minted just now. */
  setCookie: string | null;
}

/**
 * Resolves the guest identity for one proxy call.
 *
 * Minting happens only on the call that STARTS a scan (POST /api/scan), never
 * on a poll or on a read: a page that merely reads must not be able to create
 * identities, and a poll that lost its cookie should fail loudly instead of
 * quietly continuing as someone else.
 *
 * A signed-in caller is handled by the backend preferring its session, so this
 * side does not need to know who is signed in - minting a token a session will
 * override costs one cookie and keeps one code path.
 */
function resolveGuest(req: NextRequest, mayMint: boolean): GuestIdentity {
  const stored = req.cookies.get(GUEST_COOKIE)?.value;
  const secret = guestSecret();
  const existing = validGuestToken(stored, secret);
  if (existing) return { token: existing, setCookie: null };
  if (!mayMint || !secret) return { token: null, setCookie: null };
  const minted = mintGuestToken(secret);
  return { token: minted, setCookie: guestCookie(minted) };
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

function backendUrl(path: string[]): string {
  return `${BACKEND}/api/v1/scan${path.length ? "/" + path.map(encodeURIComponent).join("/") : ""}`;
}

async function proxy(req: NextRequest, path: string[], body?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const cookie = req.headers.get("cookie");
  if (cookie) headers["cookie"] = cookie;
  const auth = req.headers.get("authorization");
  if (auth) headers["authorization"] = auth;

  // Mint only for the call that starts a scan (no path segment = POST /api/scan).
  const guest = resolveGuest(req, req.method === "POST" && path.length === 0);
  if (guest.token) headers["x-guest-token"] = guest.token;

  try {
    const res = await fetch(backendUrl(path), {
      method: req.method,
      headers,
      body,
      signal: upstreamSignal(),
    });
    const text = await res.text();
    const response = new NextResponse(text, {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
    });
    if (guest.setCookie) response.headers.append("set-cookie", guest.setCookie);
    return response;
  } catch (error) {
    // The backend did not answer inside the budget: it is reachable, just slow
    // (typically still waking up). A refused connection or DNS failure is not
    // that, and stays the existing 502 below.
    if (isTimeoutAbort(error)) {
      // Hand over the identity even though the answer is a 504. The backend
      // charges the guest's quota when it ADMITS the scan (`check_guest_rate_limit`
      // runs before the work), so the charge stands whether or not this proxy
      // waits for the reply. Dropping the cookie would leave that charge on an
      // id the caller never receives: every retry would mint a fresh guest and
      // restart `GUEST_SCAN_LIMIT_PER_DAY`, leaving the instance-wide total as
      // the only bound in exactly the case it is meant to be the second line.
      const response = timedOut();
      if (guest.setCookie) response.headers.append("set-cookie", guest.setCookie);
      return response;
    }
    return NextResponse.json({ detail: "The search service did not respond." }, { status: 502 });
  }
}

/**
 * Read the body under the size cap, or `null` when it was already refused.
 *
 * The 401 path for an unauthenticated caller is the backend's, and it runs
 * after this read - which is exactly why the read cannot be unbounded. The 413
 * is answered here, before any byte of the body is read, whenever the client
 * declared an oversized Content-Length. Otherwise the body is streamed through
 * `collectBounded`, which stops the moment it crosses the cap and cancels the
 * upload. Reading unboundedly with `req.text()` was a memory exhaustion path
 * for an anonymous caller: `middleware.ts` does not cover `/api/*`, so nothing
 * on this side says no before the read.
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
