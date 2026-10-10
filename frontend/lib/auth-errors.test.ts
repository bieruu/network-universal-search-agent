import test from "node:test";
import assert from "node:assert/strict";

import {
  describeSignInError,
  describeSignUpError,
  describeResetError,
  RESET_REQUEST_SENT,
} from "./auth-errors.ts";

/**
 * These tests exist because the failures they prevent are user-visible. Before
 * the mapper, `result.error.message` from Better Auth was rendered verbatim on
 * the sign-in and sign-up pages, so `INVALID_EMAIL_OR_PASSWORD`,
 * `INVALID_PROVIDER`, `STATE_MISMATCH` and `USER_BANNED` reached the screen.
 */

/** Anything that looks like a Better Auth machine code must not survive. */
const INTERNAL_CODES = [
  "INVALID_EMAIL_OR_PASSWORD",
  "INVALID_PROVIDER",
  "STATE_MISMATCH",
  "USER_BANNED",
  "INVALID_TOKEN",
  "RESET_PASSWORD_DISABLED",
  "FAILED_TO_CREATE_USER",
  "EMAIL_PASSWORD_SIGN_UP_DISABLED",
  "USER_NOT_FOUND",
  "TOO_MANY_REQUESTS",
];

function assertClean(text: string, context: string) {
  for (const code of INTERNAL_CODES) {
    assert.ok(!text.includes(code), `${context} leaked ${code}: ${text}`);
  }
  // SCREAMING_SNAKE tokens generally, not just the listed ones.
  assert.ok(
    !/\b[A-Z]{4,}(_[A-Z]+)+\b/.test(text),
    `${context} leaked an internal token: ${text}`,
  );
  assert.ok(!text.includes("provider configuration"), `${context} leaked operator wording: ${text}`);
  assert.ok(!text.includes("deployment"), `${context} used infrastructure wording: ${text}`);
}

test("sign-in never renders a Better Auth code verbatim", () => {
  for (const code of INTERNAL_CODES) {
    assertClean(describeSignInError({ message: code }), `sign-in (${code})`);
    assertClean(describeSignInError(code), `sign-in (${code}, string form)`);
  }
});

test("sign-in maps the email/password failure to something actionable", () => {
  const message = describeSignInError({ message: "INVALID_EMAIL_OR_PASSWORD" });
  assert.match(message, /do not match/i);
  assert.match(message, /reset your password/i, "must point at the reset flow");
});

test("sign-in maps the OAuth failure without mentioning provider configuration", () => {
  const thrown = describeSignInError({ message: "INVALID_PROVIDER" });
  assertClean(thrown, "sign-in (INVALID_PROVIDER)");
  assert.match(thrown, /sign in with your email and password/i);
  assert.ok(
    !/check provider configuration/i.test(thrown),
    "operator wording must not reach the user",
  );
});

test("sign-in maps a state mismatch to a restart-the-attempt instruction", () => {
  const message = describeSignInError({ message: "STATE_MISMATCH" });
  assertClean(message, "sign-in (STATE_MISMATCH)");
  assert.match(message, /start again|expired/i);
});

test("sign-in: an unknown error never falls through to the raw message", () => {
  // The shape of an upstream diagnostic: provider name, internal URL, ids.
  const raw = "Google OAuth failed: connect ECONNREFUSED 10.0.0.7:443 (project_id=1234)";
  assertClean(describeSignInError({ message: raw }), "sign-in (unknown)");
  assert.ok(!describeSignInError({ message: raw }).includes("10.0.0.7"));
});

test("sign-in handles an absent or empty error", () => {
  for (const value of [null, undefined, {}, "", { message: undefined }]) {
    const message = describeSignInError(value as Parameters<typeof describeSignInError>[0]);
    assert.ok(message.length > 0);
    assertClean(message, "sign-in (empty)");
  }
});

test("sign-in does not enumerate accounts", () => {
  // "no such user" and "wrong password" must be indistinguishable, or the
  // sign-in form becomes an account-existence oracle.
  const unknownUser = describeSignInError({ message: "USER_NOT_FOUND" });
  const wrongPassword = describeSignInError({ message: "INVALID_EMAIL_OR_PASSWORD" });
  assert.equal(unknownUser, wrongPassword);
});

test("sign-up never renders a Better Auth code verbatim", () => {
  for (const code of INTERNAL_CODES) {
    assertClean(describeSignUpError({ message: code }), `sign-up (${code})`);
  }
});

test("sign-up: the old raw-message leak is gone", () => {
  // This exact string used to reach the page via
  // `message ?? "Account creation failed"`.
  const leaked = describeSignUpError({ message: "SQLITE_CONSTRAINT: UNIQUE failed" });
  assertClean(leaked, "sign-up (unmatched)");
  assert.ok(!leaked.includes("SQLITE_CONSTRAINT"));
  assert.ok(!leaked.includes("UNIQUE"));
});

test("sign-up tells a legitimate user what to do next", () => {
  const message = describeSignUpError({ message: "FAILED_TO_CREATE_USER" });
  assert.match(message, /sign in instead|administrator/i);
});

test("sign-up does not enumerate accounts", () => {
  // "already registered" and "blocked" are folded into one sentence on
  // purpose: splitting them tells an attacker which addresses are in use.
  const duplicate = describeSignUpError({ message: "USER_ALREADY_EXISTS" });
  const blocked = describeSignUpError({ message: "EMAIL_PASSWORD_SIGN_UP_DISABLED" });
  assert.equal(duplicate, blocked);
});

test("reset errors always say what to do next", () => {
  const cases = [
    "INVALID_TOKEN",
    "PASSWORD_TOO_SHORT",
    "USER_NOT_FOUND",
    "TOO_MANY_REQUESTS",
    "something nobody has seen",
  ];
  for (const code of cases) {
    const message = describeResetError({ message: code });
    assertClean(message, `reset (${code})`);
    assert.match(message, /try again|request a new|wait a minute|choose a password/i, `no next step for ${code}`);
  }
});

test("reset: an expired or used token says so and offers a way back", () => {
  const message = describeResetError({ message: "INVALID_TOKEN" });
  assert.match(message, /expired|already been used/i);
  assert.match(message, /request a new one/i);
});

test("forgot-password confirmation reveals nothing about the address", () => {
  // Neutral, complete, and free of the words that would distinguish a hit
  // from a miss ("your account", "we found", "does not exist").
  assert.ok(RESET_REQUEST_SENT.length > 40, "must be a complete sentence");
  assert.match(RESET_REQUEST_SENT, /if that email address has an account/i);
  assert.match(RESET_REQUEST_SENT, /spam/i, "must say what to do if it does not arrive");
  assert.ok(
    !/does not exist|no account found|unknown email/i.test(RESET_REQUEST_SENT),
    "must not enumerate",
  );
  assertClean(RESET_REQUEST_SENT, "reset confirmation");
});