/**
 * Password-reset email delivery.
 *
 * Split out of `lib/auth.ts` for two reasons: `auth.ts` throws at module load
 * without `DATABASE_URL`/`BETTER_AUTH_SECRET` and so cannot be imported by a
 * unit test, and the enumeration guarantee below is worth pinning with tests
 * rather than with a comment.
 *
 * ## The enumeration contract
 *
 * Better Auth already returns an identical body for a known and an unknown
 * address (`request-password-reset` in `dist/api/routes/password.mjs`), and it
 * burns equivalent work in both branches to blunt timing attacks. It leaves one
 * seam open: it calls `sendResetPassword` ONLY for a user it found. So the
 * two branches differ in whether mail is sent, and how long the request takes
 * if Resend is slow. {@link createResetPasswordSender} closes that seam:
 *
 *  - it never branches its return value on whether the user exists — Better
 *    Auth's own response is what the caller sees, and ours is identical;
 *  - on a delivery failure it logs a warning containing NO address and rethrows
 *    nothing, so a Resend outage cannot turn into a "this account does not
 *    exist" answer;
 *  - it returns `void`, never an outcome, so there is no channel for a
 *    known-vs-unknown difference to travel back down.
 *
 * ## Failing closed
 *
 * With no `RESEND_API_KEY` we log once for operators and return without sending
 * anything. We deliberately do NOT throw there: Better Auth awaits this
 * callback, and a throw would surface as a 500 to the anonymous caller, which
 * is both a worse experience and a distinguishing signal (unknown addresses
 * already short-circuit before this function runs, so only a *known* address
 * would 500). Silently not sending is the smaller sin; the operator warning
 * says so loudly. See `describeResetDeliveryMode` below and the test that pins
 * it.
 */

export type ResetSenderEnv = Record<string, string | undefined>;

/** One outbound message. `from` is resolved here, never by the caller. */
export type ResetMessage = {
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string;
};

export type ResetSenderDeps = {
  /** Sends one message. Rejecting is treated as "not delivered". */
  send: (args: ResetMessage) => Promise<void>;
  /** Operator log. Never receives an email address. */
  warn?: (message: string) => void;
};

const RESET_SUBJECT = "Reset your Universal Search password";

/** Operator-visible, and shown nowhere in the UI. */
export function describeResetDeliveryMode(env: ResetSenderEnv = process.env): string | null {
  if (!env.RESEND_API_KEY?.trim()) {
    return (
      "RESEND_API_KEY is not set: password reset emails will NOT be sent. " +
      "Set it to enable password reset."
    );
  }
  return null;
}

/** Escapes text for interpolation into the HTML body. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Builds the HTML body. `url` is escaped, not trusted: it is assembled from
 * `baseURL`, which is an operator-supplied env var, and an unescaped `&` in a
 * query string is enough to break the markup.
 */
export function resetEmailHtml(url: string, appName = "Universal Search"): string {
  const safeUrl = escapeHtml(url);
  const safeName = escapeHtml(appName);
  return [
    `<p>Someone asked to set a new password for their ${safeName} account.</p>`,
    `<p><a href="${safeUrl}">Set a new password</a></p>`,
    "<p>This link works once and stops working after an hour. If you did not ask for it, ignore this email and nothing changes — your current password still works.</p>",
  ].join("");
}

export function resetEmailText(url: string, appName = "Universal Search"): string {
  return [
    `Someone asked to set a new password for their ${appName} account.`,
    "",
    `Set a new password: ${url}`,
    "",
    "This link works once and stops working after an hour.",
    "If you did not ask for it, ignore this email — nothing changes.",
  ].join("\n");
}

/**
 * The `emailAndPassword.sendResetPassword` implementation.
 *
 * Deliberately takes `{ user, url }` structurally rather than importing
 * Better Auth's types, so this module stays importable under `node --test`
 * with no framework present.
 */
export function createResetPasswordSender(env: ResetSenderEnv, deps: ResetSenderDeps) {
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const missingKeyWarning = describeResetDeliveryMode(env);
  // Log once per process, not once per request: a scan-free app should not
  // produce a warning storm, and an operator only needs to be told once.
  let warnedMissingKey = false;
  if (missingKeyWarning) {
    warnedMissingKey = true;
    warn(missingKeyWarning);
  }
  const from = env.AUTH_FROM_EMAIL?.trim() || "Universal Search <noreply@example.com>";

  // Returns `void` because that is what Better Auth's
  // `sendResetPassword` contract requires. The delivered/not-delivered outcome
  // is deliberately NOT surfaced to the caller: it must not become a signal.
  return async function sendResetPassword(args: {
    user: { email: string };
    url: string;
    /** Present in the Better Auth call; unused here on purpose. */
    token?: string;
  }): Promise<void> {
    if (missingKeyWarning) {
      if (!warnedMissingKey) warn(missingKeyWarning);
      warnedMissingKey = true;
      // Fail closed: no key means no pretending. Do not throw — see the module
      // comment on why a throw would be an enumeration oracle.
      return;
    }

    try {
      await deps.send({
        to: args.user.email,
        from,
        subject: RESET_SUBJECT,
        html: resetEmailHtml(args.url),
        text: resetEmailText(args.url),
      });
    } catch {
      // No address, no provider error text: operators get the fact, users get
      // the neutral confirmation from the forgot-password page either way.
      warn("Password reset email could not be delivered: the mail provider rejected or timed out the send.");
    }
  };
}

export type SendResetPassword = ReturnType<typeof createResetPasswordSender>;

/** Exported for the auth config; the `from` argument is not user-controlled. */
export type ResendSendArgs = {
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string;
};