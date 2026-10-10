import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canCreateAccount,
  isSelfServiceSignupEnabled,
  isSignupEmailAllowed,
  parseBooleanFlag,
  parseSignupAllowlist,
  resolveSignupPolicy,
  signupClosedBody,
  SIGNUP_CLOSED_TITLE,
  SIGNUP_RESTRICTED_BODY,
} from "./signup-gate.ts";

const here = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(here, "..", "app", "(auth)", "sign-up", "page.tsx"), "utf8");
const form = readFileSync(join(here, "..", "app", "(auth)", "sign-up", "sign-up-form.tsx"), "utf8");
const authSrc = readFileSync(join(here, "..", "lib", "auth.ts"), "utf8");

// --- enabled vs disabled -----------------------------------------------------

test("parseBooleanFlag only accepts unambiguous booleans", () => {
  for (const v of ["1", "true", "TRUE", " yes ", "on", "enabled"]) {
    assert.equal(parseBooleanFlag(v), true, v);
  }
  for (const v of ["0", "false", "NO", "off", "disabled"]) {
    assert.equal(parseBooleanFlag(v), false, v);
  }
  // Anything ambiguous is reported as unset, not guessed at.
  for (const v of [undefined, "", "   ", "maybe", "2"]) {
    assert.equal(parseBooleanFlag(v), null, JSON.stringify(v));
  }
});

test("production defaults to closed so a deploy cannot open the cost vector by omission", () => {
  assert.equal(isSelfServiceSignupEnabled({ NODE_ENV: "production" }), false);
  assert.equal(isSelfServiceSignupEnabled({ NODE_ENV: "production", SIGNUP_ENABLED: "" }), false);
  // A typo must not silently opt in.
  assert.equal(isSelfServiceSignupEnabled({ NODE_ENV: "production", SIGNUP_ENABLED: "maybe" }), false);
});

test("dev and test stay open so the documented local flow keeps working", () => {
  assert.equal(isSelfServiceSignupEnabled({ NODE_ENV: "development" }), true);
  assert.equal(isSelfServiceSignupEnabled({ NODE_ENV: "test" }), true);
});

test("an explicit SIGNUP_ENABLED always wins, in either environment", () => {
  assert.equal(isSelfServiceSignupEnabled({ NODE_ENV: "production", SIGNUP_ENABLED: "true" }), true);
  assert.equal(isSelfServiceSignupEnabled({ NODE_ENV: "production", SIGNUP_ENABLED: "1" }), true);
  assert.equal(isSelfServiceSignupEnabled({ NODE_ENV: "development", SIGNUP_ENABLED: "false" }), false);
  assert.equal(isSelfServiceSignupEnabled({ NODE_ENV: "development", SIGNUP_ENABLED: "off" }), false);
});

// --- allowlist parsing -------------------------------------------------------

test("allowlist parses exact addresses, domains and mixed separators", () => {
  const list = parseSignupAllowlist("Alice@Example.com, @team.example.org ; *@wild.dev\nbare.net");
  assert.equal(list.emails.size, 1);
  assert.ok(list.emails.has("alice@example.com"));
  assert.deepEqual([...list.domains].sort(), ["bare.net", "team.example.org", "wild.dev"]);
});

test("an absent or blank allowlist yields no restriction", () => {
  for (const raw of [undefined, "", "   ", ",;,"]) {
    const list = parseSignupAllowlist(raw);
    assert.equal(list.emails.size, 0, JSON.stringify(raw));
    assert.equal(list.domains.size, 0, JSON.stringify(raw));
  }
});

// --- allowlist matching ------------------------------------------------------

test("with no allowlist configured every email is admissible", () => {
  const open = parseSignupAllowlist(undefined);
  assert.equal(isSignupEmailAllowed("anyone@anywhere.tld", open), true);
  assert.equal(isSignupEmailAllowed(undefined, open), true);
});

test("an allowlisted address is allowed and a non-allowlisted one is not", () => {
  const list = parseSignupAllowlist("ops@example.com");
  assert.equal(isSignupEmailAllowed("ops@example.com", list), true);
  assert.equal(isSignupEmailAllowed("OPS@Example.COM", list), true, "match must be case-insensitive");
  assert.equal(isSignupEmailAllowed("  ops@example.com  ", list), true, "match must ignore padding");
  assert.equal(isSignupEmailAllowed("attacker@evil.tld", list), false);
  assert.equal(isSignupEmailAllowed("ops@sub.example.com", list), false);
});

test("a domain entry admits any address on exactly that domain, not a subdomain", () => {
  const list = parseSignupAllowlist("@corp.example");
  assert.equal(isSignupEmailAllowed("anyone@corp.example", list), true);
  assert.equal(isSignupEmailAllowed("anyone@mail.corp.example", list), false, "subdomain must not match");
  assert.equal(isSignupEmailAllowed("anyone@notcorp.example", list), false);
});

test("malformed emails never pass an allowlist", () => {
  const list = parseSignupAllowlist("@corp.example");
  for (const bad of [null, undefined, "", "   ", "no-at-sign", "@corp.example", "user@"]) {
    assert.equal(isSignupEmailAllowed(bad, list), false, JSON.stringify(bad));
  }
});

// --- the combined admission decision ----------------------------------------

test("a closed gate denies account creation even for an allowlisted email", () => {
  const policy = resolveSignupPolicy({
    NODE_ENV: "production",
    SIGNUP_ENABLED: "false",
    SIGNUP_EMAIL_ALLOWLIST: "ops@example.com",
  });
  assert.equal(policy.enabled, false);
  assert.equal(policy.restricted, true);
  assert.equal(canCreateAccount("ops@example.com", policy), false);
});

test("an enabled gate with no allowlist admits anyone, and still blocks nobody by accident", () => {
  const policy = resolveSignupPolicy({ NODE_ENV: "development" });
  assert.equal(policy.enabled, true);
  assert.equal(policy.restricted, false);
  assert.equal(canCreateAccount("anyone@anywhere.tld", policy), true);
});

test("an enabled gate with an allowlist admits only listed addresses", () => {
  const policy = resolveSignupPolicy({
    NODE_ENV: "development",
    SIGNUP_EMAIL_ALLOWLIST: "ops@example.com,@corp.example",
  });
  assert.equal(policy.enabled, true);
  assert.equal(policy.restricted, true);
  assert.equal(canCreateAccount("ops@example.com", policy), true);
  assert.equal(canCreateAccount("staff@corp.example", policy), true);
  assert.equal(canCreateAccount("stranger@evil.tld", policy), false);
  assert.equal(canCreateAccount(undefined, policy), false);
});

test("closed-state copy is user-facing and distinguishes the allowlist case", () => {
  const closedPlain = resolveSignupPolicy({ NODE_ENV: "production" });
  const closedRestricted = resolveSignupPolicy({ NODE_ENV: "production", SIGNUP_EMAIL_ALLOWLIST: "@corp.example" });
  assert.equal(SIGNUP_CLOSED_TITLE, "Sign-up is closed");
  for (const body of [signupClosedBody(closedPlain), signupClosedBody(closedRestricted)]) {
    assert.ok(body.length > 0);
    assert.match(body, /administrator/i);
    assert.ok(!body.includes("@"), "the copy must not leak allowed addresses");
  }
  assert.ok(SIGNUP_RESTRICTED_BODY.length > 0);
  assert.ok(!SIGNUP_RESTRICTED_BODY.includes("@corp.example"), "notice must not leak the allowlist");
});

// --- wiring into the server-authoritative gate -------------------------------

test("the gate is enforced server-side on both sign-up paths", () => {
  assert.ok(
    authSrc.includes("disableSignUp: !signupPolicy.enabled"),
    "email/password sign-up must be disabled by the gate",
  );
  assert.ok(authSrc.includes("databaseHooks"), "the allowlist hook must be wired");
  assert.ok(authSrc.includes("user: {") && authSrc.includes("create: {"), "user.create.before hook required");
  assert.ok(
    authSrc.includes("canCreateAccount(user.email, signupPolicy)"),
    "the hook must consult the shared admission decision",
  );
  assert.ok(authSrc.includes("return false"), "the hook must abort creation by returning false");
});

test("requireEmailVerification stays off because no mail transport is wired", () => {
  // Enabling it without sendVerificationEmail would create accounts that can
  // never sign in: Better Auth rejects the login with EMAIL_NOT_VERIFIED.
  assert.ok(!authSrc.includes("requireEmailVerification"), "must not require email verification");
  assert.ok(!authSrc.includes("sendVerificationEmail"), "no mail transport is configured");
  assert.ok(!form.includes("requireEmailVerification"), "client must not reference it either");
});

test("a closed sign-up page renders an alert state, not a blank screen", () => {
  assert.ok(page.includes("resolveSignupPolicy()"), "the page must read the policy");
  assert.ok(page.includes("if (!policy.enabled)"), "the page must branch on the gate");
  assert.ok(page.includes("SIGNUP_CLOSED_TITLE"), "closed state must use the shared title");
  assert.ok(page.includes("signupClosedBody(policy)"), "closed state must show the shared body");
  assert.ok(page.includes('role="alert"'), "closed state must be announced to assistive tech");
  assert.ok(page.includes('href="/sign-in"'), "closed state must offer a way back to sign-in");
  assert.ok(page.includes("buttonClasses"), "closed state must style its escape hatch as a button");
  assert.ok(page.includes("<SignUpForm restricted={policy.restricted} />"), "open state still renders the form");
  assert.ok(page.includes("force-dynamic"), "gate must be read at request time, not baked at build time");
});

test("the open form explains an active allowlist and localises a gate rejection", () => {
  assert.ok(form.includes("restricted = false"), "the restricted prop must default to false");
  assert.ok(form.includes("SIGNUP_RESTRICTED_BODY"), "the allowlist notice must be rendered");
  assert.ok(form.includes("describeSignUpError"), "gate rejections must be mapped to clear copy");
  // The mapper's rejection copy now lives in `lib/auth-errors.ts` (it is shared
  // and unit-tested there); assert it is imported AND routed through, rather
  // than pinning the wording here.
  assert.ok(form.includes('from "@/lib/auth-errors"'), "the shared error mapper must be imported");
  assert.ok(form.includes("describeSignUpError(result.error)"), "rejections must be mapped, not rendered raw");
  // The client must never read the allowlist itself: the form is a client
  // component, so resolving the policy there risks bundling operators' email
  // addresses into the browser payload. It only receives a boolean.
  assert.ok(!form.includes("resolveSignupPolicy"), "the client must not resolve the policy");
  assert.ok(!form.includes("isSignupEmailAllowed"), "the client must not match emails against the allowlist");
  assert.ok(!form.includes("SIGNUP_EMAIL_ALLOWLIST"), "the client must not name the allowlist env var");
  // The pre-existing behaviour the other suites assert on must survive.
  assert.ok(form.includes("authClient.signUp.email"), "email sign-up still wired");
  assert.ok(form.includes("authClient.signIn.social"), "social sign-in still wired");
  assert.ok(form.includes('role="alert"'), "inline error alert retained");
});

test("the gate introduces no NEXT_PUBLIC secret surface", () => {
  for (const src of [authSrc, page, form]) {
    assert.ok(!/NEXT_PUBLIC_[A-Z_]*(SECRET|KEY|TOKEN)/.test(src), "no secret may use a NEXT_PUBLIC_ prefix");
  }
});