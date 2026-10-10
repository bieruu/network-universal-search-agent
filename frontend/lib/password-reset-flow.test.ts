import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { takeResetConfirmation, setResetConfirmation, RESET_DONE_MESSAGE } from "./reset-confirmation.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...parts: string[]) => readFileSync(join(here, ...parts), "utf8");

const auth = read("auth.ts");
const forgotPage = read("..", "app", "(auth)", "forgot-password", "page.tsx");
const forgotForm = read("..", "app", "(auth)", "forgot-password", "forgot-password-form.tsx");
const resetPage = read("..", "app", "(auth)", "reset-password", "page.tsx");
const resetForm = read("..", "app", "(auth)", "reset-password", "reset-password-form.tsx");
const signIn = read("..", "app", "(auth)", "sign-in", "_components", "modern-animated-sign-in.tsx");
const signUp = read("..", "app", "(auth)", "sign-up", "sign-up-form.tsx");
const middleware = read("..", "middleware.ts");

/* ------------------------- server wiring (lib/auth.ts) ------------------- */

test("auth config wires sendResetPassword into emailAndPassword", () => {
  assert.ok(auth.includes("sendResetPassword,"), "sendResetPassword must be passed to betterAuth");
  assert.ok(auth.includes("createResetPasswordSender"), "must use the tested sender");
});

test("the Resend key is only read server-side and never reaches the client bundle", () => {
  const config = read("auth-client.ts");
  assert.ok(!config.includes("RESEND"), "auth client must not reference the mail provider");
  assert.ok(!forgotForm.includes("RESEND_API_KEY"), "the browser bundle must not name the key");
});

test("auth.ts logs the missing-key state rather than pretending to send", () => {
  // The warn path lives in reset-email.ts; auth.ts must not swallow failures.
  assert.ok(!/sendResetPassword[^\n]*catch/.test(auth), "no silent catch around the send");
});

/* -------------------------------- routes ---------------------------------- */

test("the reset routes exist and are reachable while signed out", () => {
  assert.ok(forgotPage.includes("ForgotPasswordForm"));
  assert.ok(resetPage.includes("ResetPasswordForm"));
  // middleware gates only the dashboard; a reset page behind a session gate
  // could never be used by the person holding the emailed token.
  assert.ok(middleware.includes('matcher: ["/dashboard/:path*"]'));
  assert.ok(!middleware.includes("forgot-password") && !middleware.includes("reset-password"));
});

test("the forgot-password form shows one confirmation for every outcome", () => {
  assert.ok(forgotForm.includes("RESET_REQUEST_SENT"));
  assert.ok(forgotForm.includes("authClient.requestPasswordReset"));
  // The catch and the result.error branch must both land on the same state.
  const setSent = (forgotForm.match(/setSent\(true\)/g) ?? []).length;
  assert.ok(setSent >= 3, "success, error and catch must all show the same confirmation");
  // And no branch may render a different message.
  assert.ok(!forgotForm.includes("describeResetError"), "must not branch on the outcome");
});

test("the reset form handles every state the flow can produce", () => {
  assert.ok(resetForm.includes("authClient.resetPassword"));
  for (const label of ["New password", "Confirm new password"]) {
    assert.ok(resetForm.includes(label), `missing field: ${label}`);
  }
  // No token, expired/used token (query error), short password, mismatch.
  assert.ok(resetForm.includes("!token"), "missing-token branch");
  assert.ok(resetForm.includes("describeResetError(error)"), "expired/invalid-token branch");
  assert.ok(resetForm.includes("at least 8 characters"), "short-password message");
  assert.ok(resetForm.includes("do not match"), "mismatch message");
  assert.ok(resetForm.includes('href="/forgot-password"'), "every failure offers a way back");
  assert.ok(resetForm.includes('router.push("/sign-in")'), "success lands on sign-in");
});

test("both new forms are accessible", () => {
  for (const [name, src] of [["forgot", forgotForm], ["reset", resetForm]] as const) {
    assert.ok(src.includes("<Label htmlFor="), `${name}: Label htmlFor required`);
    assert.ok(src.includes("aria-describedby="), `${name}: helper/error wiring required`);
    assert.ok(src.includes("aria-busy={pending}"), `${name}: aria-busy on submit required`);
    assert.ok(src.includes('role="alert"'), `${name}: alert region required`);
    assert.ok(/pending \? "Sending…"|pending \? "Saving…"/.test(src), `${name}: pending label required`);
    assert.ok(!src.includes("dangerouslySetInnerHTML"), `${name}: no raw HTML`);
  }
  assert.ok(forgotForm.includes('aria-invalid='), "invalid field must be marked");
  assert.ok(resetForm.includes("tabIndex={-1}"), "error region must be focusable");
});

test("sign-in and sign-up both link to the reset flow", () => {
  assert.ok(signIn.includes('href="/forgot-password"'), "sign-in link required");
  assert.ok(signUp.includes('href="/forgot-password"'), "sign-up link required");
  assert.ok(signIn.includes("Forgot password?"), "the link must be labelled, not just wired");
});

test("the sign-in page surfaces the reset confirmation", () => {
  assert.ok(signIn.includes("takeResetConfirmation"));
  assert.ok(signIn.includes("RESET_DONE_MESSAGE"));
  assert.ok(signIn.includes('role="status"'), "a confirmation is a status, not an alert");
});

test("no auth surface logs a secret or renders a raw Better Auth message", () => {
  for (const [name, src] of Object.entries({ forgotForm, resetForm, signIn, signUp })) {
    assert.ok(!/console\.log\(/.test(src), `${name}: no console.log`);
    assert.ok(!/result\.error\.message/.test(src), `${name}: no raw Better Auth message rendered`);
    assert.ok(!/dangerouslySetInnerHTML/.test(src), `${name}: no raw HTML`);
    assert.ok(!/RESEND_API_KEY|BETTER_AUTH_SECRET|DATABASE_URL|SHODAN_API_KEY/.test(src), `${name}: no secret names`);
  }
});

/* ---------------------- confirmation hand-off ----------------------------- */

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

test("the reset confirmation is carried once and then cleared", () => {
  const storage = fakeStorage();
  assert.equal(takeResetConfirmation(storage), false, "nothing set yet");
  setResetConfirmation(storage);
  assert.equal(takeResetConfirmation(storage), true, "read exactly once");
  assert.equal(takeResetConfirmation(storage), false, "and cleared, so a refresh does not repeat it");
});

test("the confirmation payload carries no token, address or user id", () => {
  const storage = fakeStorage();
  setResetConfirmation(storage);
  // The only value ever written is the constant below.
  for (const [, value] of storage.map) {
    assert.equal(value, "done");
  }
  assert.ok(!RESET_DONE_MESSAGE.includes("@"), "no address in the copy");
});

test("a storage failure never throws", () => {
  const broken = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
    removeItem: () => undefined,
  };
  assert.equal(takeResetConfirmation(broken as never), false);
  setResetConfirmation(broken as never);
});