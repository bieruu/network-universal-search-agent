/**
 * Better Auth error codes -> something a person can act on.
 *
 * Why this module exists: `result.error.message` from Better Auth is the raw
 * server string, and Better Auth mints codes for conditions the user cannot see
 * or control. Rendering it verbatim puts `INVALID_EMAIL_OR_PASSWORD`,
 * `INVALID_PROVIDER`, `STATE_MISMATCH` and `USER_BANNED` on screen, and the
 * `catch` fallbacks next to it told end users to "check provider
 * configuration" — an operator message, not a user one.
 *
 * The house voice (see `lib/user-errors.ts`): what failed, why when known, what
 * to do next. Two rules this file must never break:
 *
 *  1. Nothing here is account-enumerable. A message must not distinguish
 *     "this account exists" from "this account does not". Where Better Auth
 *     gives us a code that would leak that, we collapse it into a message that
 *     covers both cases.
 *  2. No server plumbing in the output. No codes, no provider ids, no
 *     "check your configuration".
 *
 * Pure functions, no React and no `better-auth` import, so `node --test` can
 * exercise them directly.
 */

/** Any Better Auth / fetch-ish failure, narrowed to what we actually read. */
type RawError = { message?: string } | string | null | undefined;

function textOf(error: RawError): string {
  if (typeof error === "string") return error.toLowerCase();
  if (error && typeof error.message === "string") return error.message.toLowerCase();
  return "";
}

function hasAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

/**
 * Sign-in. Used on BOTH the email/password path and the OAuth path — the
 * second one used to be the worst offender, because OAuth codes arrive on the
 * normal `result.error` branch with no catch of their own.
 */
export function describeSignInError(error: RawError): string {
  const text = textOf(error);

  if (!text) {
    return "We could not sign you in. Try again, and if it keeps happening use the reset link below.";
  }

  // Rate limiting is real and actionable, so it keeps its own copy.
  if (hasAny(text, ["too many requests", "rate limit", "rate_limit"])) {
    return "Too many sign-in attempts. Wait a minute, then try again.";
  }

  // One message for "wrong password", "no such user" and "account exists but
  // uses a social login" — any split would tell an attacker which addresses
  // have accounts here.
  if (
    hasAny(text, [
      "invalid_email_or_password",
      "invalid email or password",
      "invalid credentials",
      "user not found",
      "user_not_found",
      "invalid user",
      "email not found",
      "account not found",
    ])
  ) {
    return "That email and password do not match an account here. Check both, or reset your password.";
  }

  // A banned or disabled account is worth naming, but only in a way that does
  // not confirm the account exists to somebody who guessed the address.
  if (hasAny(text, ["user_banned", "user banned", "banned", "account is disabled", "account_disabled"])) {
    return "This account can no longer sign in. Contact an administrator to have it re-enabled.";
  }

  if (
    hasAny(text, [
      "state_mismatch",
      "state mismatch",
      "invalid_state",
      "csrf",
      "invalid_callback",
      "callback_url",
      "origin",
    ])
  ) {
    return "That sign-in link or attempt expired before it finished. Start again from this page.";
  }

  // Provider ids and OAuth config are operator detail. The user only needs to
  // know the attempt did not complete and that another method exists.
  if (
    hasAny(text, [
      "invalid_provider",
      "invalid provider",
      "provider",
      "oauth",
      "social",
      "access_denied",
      "popup",
      "not_supported",
      "unsupported",
    ])
  ) {
    return "That sign-in method did not complete. Try again, or sign in with your email and password.";
  }

  if (hasAny(text, ["email_password_disabled", "email and password is disabled", "account creation is disabled"])) {
    return "Signing in with a password is switched off here. Use one of the other sign-in methods.";
  }

  if (hasAny(text, ["failed to fetch", "network", "load failed", "timeout", "timed out", "econnrefused"])) {
    return "We could not reach the server. Check your connection and try again.";
  }

  // Unknown code: never pass the raw text through. It may be a code we have
  // not seen, or an upstream message carrying provider diagnostics.
  return "We could not sign you in. Try again, and if it keeps happening use the reset link below.";
}

/**
 * Sign-up. Better Auth answers a blocked or duplicate registration with a
 * deliberately generic FAILED_TO_CREATE_USER / EMAIL_PASSWORD_SIGN_UP_DISABLED
 * so an anonymous caller cannot probe the allowlist. "Failed to create user" is
 * useless to someone who mistyped their address, so map it to something
 * actionable — without splitting the known-email case from the unknown one.
 */
export function describeSignUpError(error: RawError): string {
  const text = textOf(error);

  if (hasAny(text, ["too many requests", "rate limit", "rate_limit"])) {
    return "Too many attempts from here. Wait a minute, then try again.";
  }

  if (
    hasAny(text, [
      "failed to create user",
      "failed_to_create_user",
      "sign up is not enabled",
      "sign_up_disabled",
      "email_password_sign_up_disabled",
      "sign-up is disabled",
      "user already exists",
      "email_exists",
      "user_already_exists",
    ])
  ) {
    // Deliberately one sentence for "blocked" and "already registered" alike.
    return "Sign-up is not available for this email address. If you already have an account, sign in instead, or ask an administrator for access.";
  }

  if (hasAny(text, ["password is too short", "password_too_short", "password is too long", "password_too_long"])) {
    return "Choose a password between 8 and 128 characters.";
  }

  if (hasAny(text, ["failed to fetch", "network", "load failed", "timeout", "timed out", "econnrefused"])) {
    return "We could not reach the server. Check your connection and try again.";
  }

  if (hasAny(text, ["user_banned", "banned", "disabled"])) {
    return "This account cannot be used here. Contact an administrator for access.";
  }

  // No raw fallback: `message ?? "Account creation failed"` used to leak any
  // unmatched Better Auth string straight onto the page.
  return "We could not create that account. Check the details and try again.";
}

/** Reset-password form failures. `token` states come from the callback route. */
export function describeResetError(error: RawError): string {
  const text = textOf(error);

  if (hasAny(text, ["invalid_token", "invalid token", "token_expired", "token is expired", "expired"])) {
    return "This reset link has expired or has already been used. Request a new one and try again.";
  }

  if (hasAny(text, ["password is too short", "password_too_short"])) {
    return "Choose a password of at least 8 characters.";
  }

  if (hasAny(text, ["password is too long", "password_too_long"])) {
    return "Choose a password of no more than 128 characters.";
  }

  if (hasAny(text, ["user_not_found", "user not found"])) {
    return "This reset link does not match an account here. Request a new one and try again.";
  }

  if (hasAny(text, ["too many requests", "rate limit", "rate_limit"])) {
    return "Too many attempts. Wait a minute, then try again.";
  }

  if (hasAny(text, ["failed to fetch", "network", "load failed", "timeout", "timed out", "econnrefused"])) {
    return "We could not reach the server. Check your connection and try again.";
  }

  return "We could not reset that password. Request a new link and try again.";
}

/**
 * The one message the forgot-password page shows for EVERY outcome — success,
 * unknown address, mail failure. Enumeration defence: if the known-email and
 * unknown-email paths read differently, this form becomes an account oracle.
 * It must therefore say nothing about whether the account exists.
 */
export const RESET_REQUEST_SENT =
  "If that email address has an account here, a link to set a new password is on its way. It arrives within a minute and stops working after an hour. If it does not arrive, check your spam folder or try a different address.";