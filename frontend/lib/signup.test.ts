import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "app", "(auth)", "sign-up", "sign-up-form.tsx"), "utf8");
const auth = readFileSync(join(here, "..", "lib", "auth.ts"), "utf8");
const route = readFileSync(join(here, "..", "app", "api", "auth", "[...all]", "route.ts"), "utf8");

test("sign-up uses the real Better Auth email and social APIs", () => {
  assert.ok(src.includes("authClient.signUp.email"), "email sign-up is wired to Better Auth");
  assert.ok(src.includes("authClient.signIn.social"), "social sign-in is wired to Better Auth");
  assert.ok(src.includes('handleOAuth("google")') && src.includes('handleOAuth("github")'), "both OAuth providers are offered");
  assert.ok(src.includes('href="/sign-in"'), "sign-in link required");
});

test("sign-up validates email, password length, and confirmation", () => {
  assert.ok(src.includes("z.string().trim().email"), "email validation required");
  assert.ok(src.includes(".min(8"), "minimum password length required");
  assert.ok(src.includes("value.password === value.confirmPassword"), "password confirmation required");
});

test("Better Auth is server-backed by PostgreSQL with a mounted API route", () => {
  assert.ok(auth.includes("new Pool({ connectionString: databaseUrl })"), "PostgreSQL adapter required");
  // Matched structurally, not by literal: the object also carries the
  // sign-up gate (`disableSignUp`), but email/password auth must stay enabled.
  assert.ok(
    /emailAndPassword:\s*\{\s*enabled:\s*true/.test(auth),
    "email/password auth must be enabled",
  );
  assert.ok(auth.includes("GOOGLE_CLIENT_ID") && auth.includes("GITHUB_CLIENT_ID"), "OAuth credentials are configurable");
  assert.ok(route.includes("toNextJsHandler(auth)"), "Better Auth Next.js handler required");
});
