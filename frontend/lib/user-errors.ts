/**
 * Turns HTTP outcomes into something worth reading.
 *
 * The rule here is blunt: a status code is never the message. Before the copy
 * audit, a failed scan rendered a badge reading `Request failed (500)` and a
 * rejected target rendered `Backend unreachable` — which tells a user nothing
 * about whether to retry, and describes plumbing they cannot act on.
 *
 * We deliberately do NOT echo the backend's `detail` string into the UI. That
 * field carries raw FastAPI validation arrays (`{"loc":["body","target"],...}`),
 * provider exception text, and proxy diagnostics. It is untrusted input from
 * AGENTS.md §5.4 and it is not written for a human. It is preserved on
 * {@link UserFacingError.technicalDetail} for the console instead, so a bug
 * report still carries the evidence.
 */

export class UserFacingError extends Error {
  /** Machine-readable cause for logs and telemetry. Never rendered. */
  readonly status: number;
  /** Raw upstream text, kept for the console only. */
  readonly technicalDetail: string | undefined;

  constructor(message: string, status: number, technicalDetail?: string) {
    super(message);
    this.name = "UserFacingError";
    this.status = status;
    this.technicalDetail = technicalDetail;
  }
}

/**
 * The one fact + the one next action, per status.
 *
 * `RATE_LIMIT` says whether to retry and roughly when, because "try again
 * later" without a horizon is the message that produces a support ticket.
 */
export function messageForStatus(status: number): string {
  if (status === 401) {
    return "Your session has ended. Sign in again to continue.";
  }
  if (status === 403) {
    return "Your account does not have access to this. Ask an administrator for access.";
  }
  if (status === 404) {
    return "We could not find that. It may have been removed, or the link may be out of date.";
  }
  if (status === 409) {
    return "That conflicts with something already saved. Refresh and try again.";
  }
  if (status === 429) {
    return "You have reached the search limit for your account. Try again in a few minutes.";
  }
  if (status === 413) {
    return "That target is too long to search. Check the address and try again.";
  }
  if (status >= 500) {
    return "Something went wrong on our side, not yours. Try again in a moment.";
  }
  if (status >= 400) {
    return "That request could not be processed. Check the details and try again.";
  }
  return "That request could not be completed. Try again in a moment.";
}

/**
 * Pull the upstream `detail` for logging only. Accepts FastAPI's two shapes
 * (`{detail: string}` and `{detail: [{loc, msg, type}]}`) plus a bare body.
 */
export function extractTechnicalDetail(body: unknown): string | undefined {
  if (typeof body === "string") return body.slice(0, 300) || undefined;
  if (body === null || typeof body !== "object") return undefined;
  const detail = (body as Record<string, unknown>)["detail"];
  if (typeof detail === "string") return detail.slice(0, 300) || undefined;
  if (detail !== undefined) {
    try {
      return JSON.stringify(detail).slice(0, 300);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Shared failure path for `api.ts` and `analysis-api.ts`. */
export function toUserFacingError(status: number, body?: unknown): UserFacingError {
  return new UserFacingError(messageForStatus(status), status, extractTechnicalDetail(body));
}

/** No response at all — offline, DNS failure, or a CORS rejection. */
export function networkError(): UserFacingError {
  return new UserFacingError(
    "We could not reach the server. Check your connection and try again.",
    0,
  );
}