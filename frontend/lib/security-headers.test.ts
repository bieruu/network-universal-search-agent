import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const layout = readFileSync(join(root, "app", "layout.tsx"), "utf8");
const config = readFileSync(join(root, "next.config.mjs"), "utf8");

// The inline theme-bootstrap script is hashed into the CSP allowlist. Editing
// app/layout.tsx without recomputing the hash silently blocks the script the
// moment CSP flips from Report-Only to enforcement (FOUC / wrong theme).
test("CSP hash matches the inline theme script", () => {
  const script = layout.match(/__html: `([\s\S]*?)`,\n/);
  assert.ok(script, "inline theme script not found in app/layout.tsx");

  const expected = createHash("sha256").update(script[1], "utf8").digest("base64");
  const declared = config.match(/sha256-([A-Za-z0-9+/=]+)/);
  assert.ok(declared, "no sha256 hash declared in next.config.mjs");
  assert.equal(
    declared[1],
    expected,
    "THEME_SCRIPT_HASH is stale — recompute it (see the comment above the constant)",
  );
});

test("CSP stays report-only until a nonce-based policy lands", () => {
  // Next.js emits inline hydration scripts (self.__next_f) that a hash allowlist
  // cannot cover, so enforcing now would break every page.
  assert.ok(
    config.includes("Content-Security-Policy-Report-Only"),
    "CSP must remain Report-Only until nonce support is implemented",
  );
  assert.ok(
    !/"Content-Security-Policy"/.test(config),
    "enforcing CSP without a nonce for self.__next_f would break hydration",
  );
});

test("baseline security headers are present on every route", () => {
  for (const header of [
    "X-Content-Type-Options",
    "X-Frame-Options",
    "Referrer-Policy",
    "Permissions-Policy",
    "Strict-Transport-Security",
  ]) {
    assert.ok(config.includes(`"${header}"`), `missing header: ${header}`);
  }
  assert.ok(config.includes('source: "/:path*"'), "headers must apply to all routes");
});

test("CSP directive set stays locked down", () => {
  for (const directive of [
    "default-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ]) {
    assert.ok(config.includes(directive), `missing directive: ${directive}`);
  }
  // 'unsafe-eval' would defeat the point of shipping a CSP at all.
  assert.ok(!config.includes("unsafe-eval"), "no unsafe-eval");
  // script-src must not be widened to unsafe-inline.
  assert.ok(!/script-src[^;"']*'unsafe-inline'/.test(config), "script-src must not allow unsafe-inline");
});
