import test from "node:test";
import assert from "node:assert/strict";

import {
  NONCE_BYTES,
  contentSecurityPolicy,
  cspHeaderName,
  generateNonce,
  nonceFromHeader,
} from "./csp.ts";

/**
 * These tests exist because the CSP is the only thing standing between a
 * reflected/compromised input and script execution, and because the directives
 * are easy to "harden" into breakage: dropping the nonce or losing
 * 'strict-dynamic' stops Next.js from hydrating; dropping 'unsafe-inline' from
 * style-src breaks Tailwind/React inline styles. The assertions below pin the
 * parts that are deliberate, so a future edit that loosens the policy fails
 * here instead of quietly shipping a decorative one.
 */

const NONCE = "ABCdef123_-456ghi7890"; // 22 chars, verbatim, URL-safe-ish

/** Pull a single directive out of the joined policy, or "" if it is absent. */
function directive(policy: string, name: string): string {
  return policy.split("; ").find((entry) => entry.startsWith(`${name} `)) ?? "";
}

test("the policy lists every directive it is supposed to, in order", () => {
  const names = contentSecurityPolicy(NONCE)
    .split("; ")
    .map((entry) => entry.split(" ")[0]);
  assert.deepEqual(names, [
    "default-src",
    "script-src",
    "style-src",
    "img-src",
    "font-src",
    "connect-src",
    "object-src",
    "base-uri",
    "form-action",
    "frame-ancestors",
  ]);
});

test("script-src carries the caller's nonce and 'strict-dynamic'", () => {
  const scriptSrc = directive(contentSecurityPolicy(NONCE), "script-src");
  assert.ok(scriptSrc.includes("'self'"));
  assert.ok(scriptSrc.includes(`'nonce-${NONCE}'`));
  assert.ok(scriptSrc.includes("'strict-dynamic'"));
});

test("the nonce a caller supplies appears verbatim in the policy", () => {
  // A caller must be able to pass a fixed nonce and assert on the output.
  const policy = contentSecurityPolicy("q1w2e3r4_-t5y6u7i8o9p0");
  assert.ok(policy.includes("'nonce-q1w2e3r4_-t5y6u7i8o9p0'"));
});

test("script-src has no 'unsafe-inline' and the policy has no 'unsafe-eval'", () => {
  const policy = contentSecurityPolicy(NONCE);
  // 'unsafe-inline' in script-src would make the nonce decorative - with
  // 'strict-dynamic' present the browser ignores it anyway, so it buys nothing.
  assert.ok(
    !directive(policy, "script-src").includes("'unsafe-inline'"),
    "script-src must not fall back to unsafe-inline",
  );
  assert.ok(!policy.includes("unsafe-eval"), "eval must stay blocked everywhere");
  // style-src DOES allow inline styles on purpose (there is no style nonce).
  assert.ok(directive(policy, "style-src").includes("'unsafe-inline'"));
});

test("'strict-dynamic' is present - it is what makes the browser ignore unsafe-inline", () => {
  assert.ok(contentSecurityPolicy(NONCE).includes("'strict-dynamic'"));
});

test("the locked-down directives are exactly what they should be", () => {
  const policy = contentSecurityPolicy(NONCE);
  assert.equal(directive(policy, "default-src"), "default-src 'self'");
  assert.equal(directive(policy, "object-src"), "object-src 'none'");
  assert.equal(directive(policy, "base-uri"), "base-uri 'self'");
  assert.equal(directive(policy, "form-action"), "form-action 'self'");
  assert.equal(directive(policy, "frame-ancestors"), "frame-ancestors 'none'");
});

test("img-src still allows the CDN the app loads its logos from", () => {
  // Removing this turns every simpleicons logo into a broken image.
  assert.ok(directive(contentSecurityPolicy(NONCE), "img-src").includes("https://cdn.simpleicons.org"));
});

test("report-only changes the header, never the policy text", () => {
  assert.equal(
    contentSecurityPolicy(NONCE, { reportOnly: true }),
    contentSecurityPolicy(NONCE),
    "the policy is the policy; only the header name differs",
  );
});

// --- which header carries the policy -----------------------------------------

test("cspHeaderName enforces in production and reports in development", () => {
  assert.equal(cspHeaderName(true), "content-security-policy");
  assert.equal(cspHeaderName(false), "content-security-policy-report-only");
});

// --- the nonce itself --------------------------------------------------------

test("NONCE_BYTES is 16 (128 bits)", () => {
  assert.equal(NONCE_BYTES, 16);
});

test("generateNonce() is a 22-char URL-safe base64 string and never repeats", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i += 1) {
    const nonce = generateNonce();
    assert.match(nonce, /^[A-Za-z0-9_-]{22}$/, `not 22 URL-safe chars: ${nonce}`);
    assert.ok(!nonce.includes("+"), "must not contain '+'");
    assert.ok(!nonce.includes("/"), "must not contain '/'");
    assert.ok(!nonce.includes("="), "must not contain '=' padding");
    seen.add(nonce);
  }
  // 128 bits of randomness: a collision across 200 draws would mean the RNG
  // is not actually random, which is the one failure that matters here.
  assert.equal(seen.size, 200, "generateNonce() returned a duplicate");
});

test("nonceFromHeader falls back to '-' and round-trips a real value", () => {
  for (const empty of [null, "", "   ", "\t\n"]) {
    assert.equal(nonceFromHeader(empty), "-", `expected '-' for ${JSON.stringify(empty)}`);
  }
  const nonce = generateNonce();
  assert.equal(nonceFromHeader(nonce), nonce, "a real nonce must survive the round trip unchanged");
});
