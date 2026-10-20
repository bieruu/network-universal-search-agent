/**
 * Guest-mode facts for the dashboard (reversal 2026-10-14: signed-out
 * visitors can scan).
 *
 * The BACKEND is authoritative for every number here: it admits the guest
 * (`require_user_or_guest`) and charges the quota (`guest_scan_limit_per_day`,
 * `guest_scan_daily_total`). This module only mirrors the per-guest default so
 * the UI can say something true before the first scan — and it is pinned to the
 * backend's default by `lib/guest-mode.test.ts`, which reads
 * `backend/app/core/config.py`. If that test fails, the backend moved: change
 * the value here, do not argue with the test.
 *
 * Copy rules this file follows: no promise the backend does not keep (a quota
 * is a quota — never "unlimited" for a guest), and a sign-in path next to every
 * limit so the restriction always comes with its way out.
 */
export const GUEST_SCAN_LIMIT_PER_DAY = 2;

/** The banner above "New scan", shown only to signed-out visitors. */
export const GUEST_BANNER_TITLE = "Guest mode";

export const GUEST_BANNER_DESCRIPTION =
  `Scanning without an account: ${GUEST_SCAN_LIMIT_PER_DAY} scans a day, not saved to history. ` +
  "Sign in to keep results and scan without the limit.";

/** Rendered instead of the 429 sentence from lib/user-errors.ts. */
export function guestQuotaMessage(): string {
  return (
    `Today's ${GUEST_SCAN_LIMIT_PER_DAY} guest scans are used. ` +
    "Sign in to keep going, or come back tomorrow."
  );
}

/** Replaces the History card for a guest: the endpoint is account-only. */
export const GUEST_HISTORY_LOCKED =
  "History is saved for accounts. Sign in to keep your scans and reopen them later.";

/** Replaces the risk-trend card for a guest: trend rows come from saved scans. */
export const GUEST_TREND_LOCKED =
  "The risk trend reads saved scans, and a guest has none. Sign in to see it.";

/**
 * True once Better Auth has ANSWERED with no session.
 *
 * Takes the `useSession()` result rather than a `status` string because the
 * client exposes `isPending` + `data`, not a status field. The `isPending` half
 * is the load-bearing one: while the check is in flight `data` is also null, and
 * showing guest chrome then would flash "Guest mode" at a signed-in analyst on
 * every cold render.
 */
export function isGuestSession(state: {
  isPending?: boolean;
  data?: unknown;
} | null): boolean {
  if (!state || state.isPending) return false;
  return !state.data;
}
