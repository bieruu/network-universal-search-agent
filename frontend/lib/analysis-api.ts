/**
 * Typed client for the backend's per-capability analysis endpoints
 * (`/api/v1/analysis/...`).
 *
 * Every call here goes through the Next proxy at `/api/analysis/...`, never
 * straight to the backend. Two reasons, and the second is the one that breaks
 * silently if ignored:
 *
 *   1. The browser must not call Shodan / crt.sh / any source itself
 *      (AGENTS.md §7) — only the backend holds the keys.
 *   2. Every analysis endpoint calls `require_user()`, so the call must arrive
 *      with the session cookie attached. Same-origin fetch sends it by default
 *      (`credentials: "same-origin"`), and the proxy forwards it. A direct call
 *      from the browser to the backend would be a 401.
 *
 * The backend URL is deliberately absent from this module: it is server-only
 * (`BACKEND_URL`, read in the proxy route) and must never reach the client.
 */

/** Where the proxy lives. Relative on purpose — see the note above. */
export const ANALYSIS_PROXY_PREFIX = "/api/analysis";

import { extractTechnicalDetail, messageForStatus } from "./user-errors.ts";

export type AnalysisCapability =
  | "headers"
  | "redirects"
  | "sitemap"
  | "contacts"
  | "dns"
  | "tls"
  | "exif"
  | "phone"
  | "capabilities";

/**
 * The capabilities that are a POST with a JSON body. `phone` carries its
 * argument in the path and `capabilities` takes no argument at all, so neither
 * can be reached through {@link runAnalysis} — passing one of them there is a
 * type error rather than a 404 from the backend.
 */
export type AnalysisPostCapability = Exclude<AnalysisCapability, "phone" | "capabilities">;

export interface AnalysisSourceError {
  source: string;
  message: string;
}

/**
 * The envelope every analysis endpoint returns.
 *
 * `T` is the shape of `data` for a given capability. It defaults to the honest
 * `Record<string, unknown>` because the backend deliberately does not model
 * each source's payload (backend/app/schemas/analysis.py): the payload is
 * third-party data, and typing it precisely here would be a claim the server
 * does not make. Narrow it at the call site, where a specific capability's
 * payload is actually being rendered.
 *
 * A capability that fails is HTTP 200 with `status: "error"` and an entry in
 * `errors` — that is not an exception and must be rendered, not retried blindly.
 */
export interface AnalysisResponse<T = Record<string, unknown>> {
  capability: string;
  target: string;
  source: string;
  status: "ok" | "error";
  data: T;
  errors: AnalysisSourceError[];
  fetched_at: string;
}

/** `GET /analysis/capabilities` — which optional sources are configured. */
export interface AnalysisCapabilities {
  always_available: string[];
  optional_sources: Record<string, boolean>;
}

/**
 * An analysis call that did not produce a response envelope.
 *
 * `detail` is the sentence a user reads, mapped from the status via
 * `messageForStatus`. It is intentionally NOT the backend's own `detail` field:
 * that field carries raw FastAPI validation arrays and provider exception
 * prose, which is untrusted and unreadable (AGENTS.md §5.4). It is preserved
 * on `technicalDetail` for the console, so a bug report still carries evidence.
 * `status` is 0 when no HTTP response was received at all.
 */
export class AnalysisError extends Error {
  readonly status: number;
  readonly detail: string;
  /** Raw upstream text. Never render this — log it. */
  readonly technicalDetail: string | undefined;

  constructor(detail: string, status = 0, technicalDetail?: string) {
    super(detail);
    this.name = "AnalysisError";
    this.detail = detail;
    this.status = status;
    this.technicalDetail = technicalDetail;
  }
}

/**
 * Error text rendered in a badge comes from `messageForStatus` (fixed-length,
 * authored strings), so it no longer needs runtime truncation. Upstream text
 * is still bounded, but on `UserFacingError.technicalDetail` in user-errors.ts.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Encode one path segment for a request to the proxy, without breaking a
 * segment that is already encoded.
 *
 * Next decodes each dynamic path segment before a route handler sees it
 * (`decodePathParams`, next/dist/server/lib/router-utils/decode-path-params.js)
 * and re-escapes the delimiters it decoded, so the handler receives `+` for a
 * `%2B` and the literal text `%2F` for a `%2F`. Encoding that blindly with
 * `encodeURIComponent` sends `%2B` (correct) but `%252F` (wrong: the backend
 * decodes one layer and receives the literal string `%2F`).
 *
 * An existing `%XX` sequence is therefore passed through, and everything else
 * is encoded. A `%` that is not part of a valid escape still gets encoded, so
 * no input is dropped.
 */
export function encodeAnalysisSegment(segment: string): string {
  return segment
    .split(/(%[0-9A-Fa-f]{2})/g)
    .map((part) => (isEscape(part) ? part : encodeURIComponent(part)))
    .join("");
}

const ESCAPE_RE = /^%[0-9A-Fa-f]{2}$/;

function isEscape(part: string): boolean {
  return ESCAPE_RE.test(part);
}

/**
 * The proxy path for a capability: `("phone", ["+1555"])` →
 * `/api/analysis/phone/%2B1555`.
 *
 * Only the capability and its arguments are encoded. The prefix is a literal
 * path, and its separators must stay separators.
 */
export function analysisProxyPath(capability: string, rest: string[] = []): string {
  return `${ANALYSIS_PROXY_PREFIX}/${[capability, ...rest].map(encodeAnalysisSegment).join("/")}`;
}

function detailFrom(status: number): string {
  // Never echo the upstream body into the UI: FastAPI validation errors arrive
  // as a JSON array of {loc,msg,type} objects and provider exceptions arrive as
  // prose. Both are untrusted (AGENTS.md §5.4) and neither is written for a
  // human. The message is mapped from the status alone; the upstream text rides
  // along on the thrown error's `technicalDetail` for the console.
  return messageForStatus(status);
}

/**
 * One fetch, one outcome. Anything that did not yield a JSON envelope throws
 * an {@link AnalysisError} carrying a readable `detail`.
 */
async function request<T>(url: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    // No HTTP response at all: the request never reached the proxy. The
    // proxy's own failure mode is different and much better — it answers 502
    // with `{"detail": "Backend unreachable"}`, which lands below.
    throw new AnalysisError("We could not reach the server. Check your connection and try again.");
  }

  const text = await res.text();
  let parsed: unknown = null;
  let json = false;
  if (text) {
    try {
      parsed = JSON.parse(text);
      json = true;
    } catch {
      json = false;
    }
  }

  if (!res.ok) {
    throw new AnalysisError(
      detailFrom(res.status),
      res.status,
      json ? extractTechnicalDetail(parsed) : undefined,
    );
  }
  if (!json) {
    throw new AnalysisError(
      "We received an unexpected reply from the server. Try again in a moment.",
      res.status,
    );
  }
  return parsed as T;
}

function normalizeErrors(value: unknown): AnalysisSourceError[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    isRecord(entry) && typeof entry["message"] === "string"
      ? [{ source: typeof entry["source"] === "string" ? entry["source"] : "", message: entry["message"] }]
      : [],
  );
}

/**
 * Coerce an envelope into `AnalysisResponse`.
 *
 * Defensive on purpose: the backend's envelope is validated, but this runs
 * against whatever came back over the network, and a missing field must
 * degrade into an empty default rather than a render-time crash in whatever
 * card is showing the result.
 */
export function normalizeAnalysisResponse<T = Record<string, unknown>>(payload: unknown): AnalysisResponse<T> {
  const raw = isRecord(payload) ? payload : {};
  const status = raw["status"] === "error" ? "error" : "ok";
  // `data` is unknown per capability, so the caller's `T` is an assertion it
  // makes at the point where it knows the shape it is about to render.
  const data = (isRecord(raw["data"]) ? raw["data"] : {}) as unknown as T;
  return {
    capability: typeof raw["capability"] === "string" ? raw["capability"] : "",
    target: typeof raw["target"] === "string" ? raw["target"] : "",
    source: typeof raw["source"] === "string" ? raw["source"] : "",
    status,
    data,
    errors: normalizeErrors(raw["errors"]),
    fetched_at: typeof raw["fetched_at"] === "string" ? raw["fetched_at"] : "",
  };
}

export type AnalysisRequestBody = Record<string, unknown>;

/**
 * Run one capability. POST to the proxy with the backend's own body shape
 * (`{url, force?}` for the fetching capabilities, `{target, force?}` for
 * `dns`/`tls`, `{data, filename?, force?}` for `exif`).
 *
 * Resolves with the envelope, including `status: "error"` — a blocked or
 * unreachable target is a 200 with `errors[]` (AGENTS.md §5.4) and the UI is
 * expected to render it. It throws only when there is no envelope at all.
 */
export async function runAnalysis<T = Record<string, unknown>>(
  capability: AnalysisPostCapability,
  body: AnalysisRequestBody = {},
): Promise<AnalysisResponse<T>> {
  const payload = await request<unknown>(analysisProxyPath(capability), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return normalizeAnalysisResponse<T>(payload);
}

/**
 * `GET /analysis/phone/{number}`.
 *
 * The number is a path parameter, so it is encoded here rather than in a body.
 */
export async function lookupPhone<T = Record<string, unknown>>(number: string): Promise<AnalysisResponse<T>> {
  const payload = await request<unknown>(analysisProxyPath("phone", [number]), { method: "GET" });
  return normalizeAnalysisResponse<T>(payload);
}

/** Which optional sources this deployment has configured (urlscan, defacement, …). */
export async function getCapabilities(): Promise<AnalysisCapabilities> {
  const payload = await request<unknown>(analysisProxyPath("capabilities"), { method: "GET" });
  const raw = isRecord(payload) ? payload : {};
  const always = Array.isArray(raw["always_available"])
    ? raw["always_available"].filter((entry): entry is string => typeof entry === "string")
    : [];
  const optional: Record<string, boolean> = {};
  if (isRecord(raw["optional_sources"])) {
    for (const [source, present] of Object.entries(raw["optional_sources"])) {
      optional[source] = present === true;
    }
  }
  return { always_available: always, optional_sources: optional };
}