import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "app", "dev-login", "route.ts"), "utf8");

test("dev-login is development-only", () => {
  assert.ok(src.includes('process.env.NODE_ENV !== "development"'), "NODE_ENV guard required");
  assert.ok(src.includes("404"), "non-dev must get 404, never a cookie");
});

test("dev-login sets the stub session cookie and bounces to dashboard", () => {
  assert.ok(src.includes("better-auth.session_token"), "same cookie the middleware checks");
  assert.ok(src.includes('"/dashboard"'), "redirect target must be /dashboard");
  assert.ok(!src.toLowerCase().includes("shodan"), "no secrets near the dev route");
});
