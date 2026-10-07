import test from "node:test";
import assert from "node:assert/strict";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { canCreateAccount, resolveSignupPolicy, type SignupEnv } from "./signup-gate.ts";

// End-to-end proof that the gate actually stops account creation, using the
// in-memory adapter that ships with the installed better-auth. No database and
// no network: `signUpEmail` and `createOAuthUser` are pure local handlers.
//
// This matters because reading the option names is not the same as showing the
// gate bites. Two behaviours are asserted that a config-only reading gets wrong:
//  1. a blocked attempt writes NO row (the hook aborts before the insert), and
//  2. `disableSignUp` alone would leave the Google/GitHub path wide open.

const SECRET = "0123456789abcdef0123456789abcdef0123456789";

type Db = { user: { email: string }[]; session: unknown[]; account: unknown[]; verification: unknown[] };

/** Mirrors the wiring in `lib/auth.ts` exactly, over an in-memory database. */
function buildInstance(env: SignupEnv) {
  const policy = resolveSignupPolicy(env);
  const db: Db = { user: [], session: [], account: [], verification: [] };
  const instance = betterAuth({
    database: memoryAdapter(db as unknown as Record<string, unknown[]>),
    secret: SECRET,
    baseURL: "http://localhost:3000",
    emailAndPassword: { enabled: true, disableSignUp: !policy.enabled },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (!canCreateAccount(user.email, policy)) return false;
          },
        },
      },
    },
  });
  return { instance, db };
}

type Attempt = { ok: boolean; code: string };

async function attemptSignUp(instance: ReturnType<typeof buildInstance>["instance"], email: string): Promise<Attempt> {
  try {
    await instance.api.signUpEmail({
      body: { name: "Test User", email, password: "correct-horse-battery-staple" },
    });
    return { ok: true, code: "CREATED" };
  } catch (error) {
    const e = error as { body?: { code?: string }; code?: string };
    return { ok: false, code: e.body?.code ?? e.code ?? "UNKNOWN" };
  }
}

// --- master switch ----------------------------------------------------------

test("a closed gate rejects sign-up and stores nothing", async () => {
  const { instance, db } = buildInstance({ NODE_ENV: "production" });
  assert.equal(instance.options.emailAndPassword?.disableSignUp, true);

  const result = await attemptSignUp(instance, "attacker@evil.tld");
  assert.equal(result.ok, false);
  assert.equal(result.code, "EMAIL_PASSWORD_SIGN_UP_DISABLED");
  assert.equal(db.user.length, 0, "no user row may be written");
});

test("an explicitly enabled gate allows sign-up", async () => {
  const { instance, db } = buildInstance({ NODE_ENV: "production", SIGNUP_ENABLED: "true" });
  assert.equal(instance.options.emailAndPassword?.disableSignUp, false);

  assert.deepEqual(await attemptSignUp(instance, "anyone@anywhere.tld"), { ok: true, code: "CREATED" });
  assert.equal(db.user.length, 1);
});

// --- allowlist --------------------------------------------------------------

test("an allowlist admits listed addresses and rejects the rest, writing no row for rejects", async () => {
  const { instance, db } = buildInstance({
    NODE_ENV: "development",
    SIGNUP_EMAIL_ALLOWLIST: "ops@example.com, @corp.example",
  });
  assert.equal(instance.options.emailAndPassword?.disableSignUp, false);

  assert.deepEqual(await attemptSignUp(instance, "OPS@example.com"), { ok: true, code: "CREATED" });
  assert.deepEqual(await attemptSignUp(instance, "staff@corp.example"), { ok: true, code: "CREATED" });

  const rejected = await attemptSignUp(instance, "attacker@evil.tld");
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "FAILED_TO_CREATE_USER");

  // The decisive assertion: the hook aborts the insert, so a rejected attempt
  // costs nothing and leaves no row behind to be cleaned up later.
  assert.deepEqual(
    db.user.map((u) => u.email).sort(),
    ["ops@example.com", "staff@corp.example"],
  );
});

// --- the OAuth path is gated too -------------------------------------------

test("the allowlist also gates OAuth account creation, which disableSignUp cannot reach", async () => {
  const { instance, db } = buildInstance({
    NODE_ENV: "development",
    SIGNUP_EMAIL_ALLOWLIST: "@corp.example",
  });
  // disableSignUp only governs the email/password endpoint, so it is false here
  // and would otherwise leave `signIn.social` free to mint accounts.
  assert.equal(instance.options.emailAndPassword?.disableSignUp, false);

  const context = await instance.$context;
  const createOAuthUser = (email: string) =>
    context.internalAdapter.createOAuthUser(
      { email, name: "OAuth User", emailVerified: true },
      { providerId: "google", accountId: "google:1", accessToken: "x", refreshToken: "y" },
    );

  await createOAuthUser("staff@corp.example");
  await assert.rejects(() => createOAuthUser("attacker@evil.tld"), /Failed to create user/i);

  assert.deepEqual(db.user.map((u) => u.email), ["staff@corp.example"]);
});

test("a closed master switch blocks OAuth creation even when an allowlist is configured", async () => {
  // Models "ops turned the master switch off but left the allowlist set":
  // the switch must win, and neither path may create an account.
  const { instance, db } = buildInstance({
    NODE_ENV: "production",
    SIGNUP_EMAIL_ALLOWLIST: "@corp.example",
  });
  assert.equal(instance.options.emailAndPassword?.disableSignUp, true);
  assert.equal(await attemptSignUp(instance, "staff@corp.example").then((r) => r.ok), false);

  const context = await instance.$context;
  await assert.rejects(
    () =>
      context.internalAdapter.createOAuthUser(
        { email: "staff@corp.example", name: "OAuth User", emailVerified: true },
        { providerId: "google", accountId: "google:1", accessToken: "x", refreshToken: "y" },
      ),
    /Failed to create user/i,
  );
  assert.equal(db.user.length, 0);
});