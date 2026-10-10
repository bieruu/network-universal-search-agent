/**
 * The "password changed" confirmation handed from `/reset-password` to
 * `/sign-in`.
 *
 * Carried in `sessionStorage`, not in the URL, for two reasons: a query
 * parameter would land in browser history, server access logs and any
 * `Referer` the next navigation sends, and it would also make the notice
 * survive a copy-paste — surviving is not the problem, leaking the fact that
 * someone just reset a password is. It is cleared on read, so a refresh does
 * not repeat it.
 *
 * No token, no address, no user id — the whole payload is one boolean.
 */

const KEY = "us:password-reset-confirmation";

export const RESET_DONE_MESSAGE =
  "Your password has been changed. Sign in with your new password.";

/** True when the last reset in this tab finished. */
export function takeResetConfirmation(storage?: Pick<Storage, "getItem" | "removeItem">): boolean {
  const store = storage ?? (typeof window === "undefined" ? undefined : window.sessionStorage);
  if (!store) return false;
  try {
    const value = store.getItem(KEY);
    if (value !== "done") return false;
    store.removeItem(KEY);
    return true;
  } catch {
    // Private mode / storage disabled. A missing notice must never block
    // sign-in, so this is swallowed rather than surfaced.
    return false;
  }
}

export function setResetConfirmation(storage?: Pick<Storage, "setItem">): void {
  const store = storage ?? (typeof window === "undefined" ? undefined : window.sessionStorage);
  if (!store) return;
  try {
    store.setItem(KEY, "done");
  } catch {
    // Same reasoning as above: the confirmation is nice-to-have.
  }
}