import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// The REAL installed helpers, not a reimplementation: this suite exists to pin
// better-auth's behaviour so an upgrade that changes it fails here instead of
// silently reintroducing the shared-bucket bug. `better-auth@1.7.7` depends on
// `@better-auth/core@1.7.7` at an exact version, so this is the same code the
// limiter itself imports (`better-auth/dist/api/rate-limiter/index.mjs`).
import {
  createRateLimitKey,
  findInvalidTrustedProxies,
  getIP,
  getIPFromHeader,
} from "@better-auth/core/utils/ip";
import {
  describeRejectedTrustedProxies,
  parseTrustedProxyEntry,
  resolveIpAddressConfig,
  resolveSignupPolicy,
} from "./signup-gate.ts";

const here = dirname(fileURLToPath(import.meta.url));
const rateLimiterSrc = readFileSync(
  join(here, "..", "node_modules", "better-auth", "dist", "api", "rate-limiter", "index.mjs"),
  "utf8",
);
const authSrc = readFileSync(join(here, "auth.ts"), "utf8");

/**
 * `lib/auth.ts` documents the options it deliberately omits, so the option
 * names appear in its comments. The "is it configured?" assertions below have
 * to look at code, not prose.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
const authCode = stripComments(authSrc);

const SIGN_UP_PATH = "/sign-up/email";

/** The key Better Auth actually stores, including the `null` -> string step. */
function bucketKey(forwardedFor: string | null, options?: { trustedProxies?: string[] }): string {
  const ip = forwardedFor === null ? null : getIPFromHeader(forwardedFor, options ?? {});
  return createRateLimitKey(ip ?? "no-trusted-ip", SIGN_UP_PATH);
}

// --- the bug, pinned ---------------------------------------------------------

test("a single-hop x-forwarded-for yields a per-IP bucket", () => {
  assert.equal(getIPFromHeader("203.0.113.7"), "203.0.113.7");
  assert.equal(bucketKey("203.0.113.7"), "203.0.113.7|/sign-up/email");
  // Two callers, two buckets: this is what stops one caller starving another.
  assert.notEqual(bucketKey("203.0.113.7"), bucketKey("198.51.100.9"));
});

test("a multi-hop chain with no trustedProxies collapses onto the shared no-trusted-ip bucket", () => {
  // This is the regression this suite guards. `getIPFromHeader` refuses any
  // chain longer than one hop because its leftmost token is client-spoofable,
  // and `getIP` has no production fallback, so every caller shares one bucket.
  const chain = "203.0.113.7, 70.41.3.18, 150.172.238.178";
  assert.equal(getIPFromHeader(chain), null);
  assert.equal(bucketKey(chain), "no-trusted-ip|/sign-up/email");
  // ...and it is genuinely shared: two different clients, one bucket.
  assert.equal(bucketKey("203.0.113.7, 70.41.3.18"), bucketKey("198.51.100.9, 70.41.3.18"));
  // A single self-declared hop is still trusted, which is why the ordering of
  // headers matters and why a forged extra hop is what triggers the collapse.
  assert.equal(bucketKey("203.0.113.7"), "203.0.113.7|/sign-up/email");
});

test("the literal no-trusted-ip and the 3-per-10-second sign-up rule are the installed ones", () => {
  // Quoting the dependency, not our reading of it: if the key or the rule
  // changes upstream, this fails instead of our comments quietly going stale.
  assert.match(rateLimiterSrc, /const NO_TRUSTED_IP_KEY = "no-trusted-ip";/);
  assert.match(
    rateLimiterSrc,
    /createRateLimitKey\(ip \?\? NO_TRUSTED_IP_KEY, path\)/,
    "an unresolved IP must still become the shared key",
  );
  // `path.startsWith("/sign-up")` => window 10, max 3.
  assert.match(
    rateLimiterSrc,
    /path\.startsWith\("\/sign-up"\)[\s\S]{0,120}window: 10,\s*max: 3/,
    "the sign-up special rule must still be 3 requests / 10 seconds",
  );
  // Rate limiting is on by default in production only.
  assert.match(
    readFileSync(
      join(here, "..", "node_modules", "better-auth", "dist", "context", "create-context.mjs"),
      "utf8",
    ),
    /enabled: options\.rateLimit\?\.enabled \?\? isProduction/,
  );
});

test("getIP returns null for a multi-hop chain outside dev/test, with no production fallback", () => {
  const headers = new Headers({ "x-forwarded-for": "203.0.113.7, 70.41.3.18" });
  // `getIP` takes the full options object; this suite only exercises the
  // `advanced.ipAddress` slice of it.
  const options = { advanced: { ipAddress: {} } } as unknown as Parameters<typeof getIP>[1];
  assert.equal(getIP(headers, options), null);
  // `disableIpTracking` is not a fix: it makes `getIP` return null on every
  // request, which is precisely the state the rate limiter bails out on.
  const disabled = {
    advanced: { ipAddress: { disableIpTracking: true } },
  } as unknown as Parameters<typeof getIP>[1];
  assert.equal(getIP(new Headers({ "x-forwarded-for": "203.0.113.7" }), disabled), null);
});

// --- the fix -----------------------------------------------------------------

test("a multi-hop chain resolves once trustedProxies names the proxy hops", () => {
  const chain = "203.0.113.7, 70.41.3.18";
  // The right-hand hops are the trusted proxies; the first untrusted hop from
  // the right is the client.
  assert.equal(
    getIPFromHeader(chain, { trustedProxies: ["70.41.3.18"] }),
    "203.0.113.7",
  );
  assert.equal(
    bucketKey(chain, { trustedProxies: ["70.41.3.18"] }),
    "203.0.113.7|/sign-up/email",
  );
  // CIDR form works the same way, which is what an operator actually writes.
  assert.equal(
    bucketKey("203.0.113.7, 10.0.0.1", { trustedProxies: ["10.0.0.0/8"] }),
    "203.0.113.7|/sign-up/email",
  );
  // Two callers behind the same proxy are back to separate buckets.
  assert.notEqual(
    bucketKey("203.0.113.7, 10.0.0.1", { trustedProxies: ["10.0.0.0/8"] }),
    bucketKey("198.51.100.9, 10.0.0.1", { trustedProxies: ["10.0.0.0/8"] }),
  );
  // Naming the wrong hops does not fall back to the client: the walk stops at
  // the first untrusted hop from the right, so a misconfigured list keys every
  // caller behind that proxy by the *proxy's* address. Still one shared bucket,
  // but a stable one — it is not spoofable, so a bad list fails toward today's
  // behaviour rather than toward "anyone can mint a bucket".
  assert.equal(getIPFromHeader(chain, { trustedProxies: ["10.0.0.0/8"] }), "70.41.3.18");
  assert.equal(
    bucketKey("203.0.113.7, 70.41.3.18", { trustedProxies: ["10.0.0.0/8"] }),
    bucketKey("198.51.100.9, 70.41.3.18", { trustedProxies: ["10.0.0.0/8"] }),
  );
  // A chain made entirely of trusted hops has no untrusted hop to return.
  assert.equal(getIPFromHeader("10.0.0.1, 10.0.0.2", { trustedProxies: ["10.0.0.0/8"] }), null);
  // An unparseable entry is dropped by Better Auth before the walk, so a typo
  // cannot silently turn into "trust the leftmost token".
  assert.equal(getIPFromHeader(chain, { trustedProxies: ["not-an-ip"] }), null);
});

test("the default configuration trusts nothing, leaving Better Auth's own fail-closed default", () => {
  const config = resolveIpAddressConfig({});
  assert.deepEqual(config.trustedProxies, []);
  assert.equal(config.rejected, 0);
  assert.equal(describeRejectedTrustedProxies(config), null);
});

// --- trusted-proxy parsing is strict, and strict in the safe direction --------

test("valid proxy entries are accepted in every form an operator would write", () => {
  assert.equal(parseTrustedProxyEntry("10.0.0.1"), "10.0.0.1");
  assert.equal(parseTrustedProxyEntry(" 10.0.0.0/8 "), "10.0.0.0/8");
  assert.equal(parseTrustedProxyEntry("192.0.2.128/32"), "192.0.2.128/32");
  assert.equal(parseTrustedProxyEntry("2606:4700::/32"), "2606:4700::/32");
  assert.equal(parseTrustedProxyEntry("::1"), "::1");
  assert.equal(parseTrustedProxyEntry("::FFFF:192.0.2.1"), "::ffff:192.0.2.1");
});

test("syntactically invalid entries are rejected rather than passed through", () => {
  for (const bad of ["", "   ", "nope", "10.0.0", "10.0.0.1.1", "10.0.0.256", "10.0.0.1/33", "::/129", "10.0.0.1/-1", "10.0.0.1/x", "1::2::3"]) {
    assert.equal(parseTrustedProxyEntry(bad), null, JSON.stringify(bad));
  }
});

test("a range covering every address is rejected: it would trust the spoofable leftmost token", () => {
  // Better Auth ACCEPTS these — that is the danger. `matchesCIDR` with prefix 0
  // returns true for every address, so the chain is walked all the way left to
  // the client-supplied token and a forged `x-forwarded-for` mints a fresh
  // bucket per request.
  assert.deepEqual(findInvalidTrustedProxies(["0.0.0.0/0", "::/0", "0.0.0.0", "::"]), []);
  assert.equal(parseTrustedProxyEntry("0.0.0.0/0"), null);
  assert.equal(parseTrustedProxyEntry("::/0"), null);
  assert.equal(parseTrustedProxyEntry("0.0.0.0"), null);
  assert.equal(parseTrustedProxyEntry("::"), null);
  // A prefix of 0 on any network is the same thing spelled differently.
  assert.equal(parseTrustedProxyEntry("10.0.0.0/0"), null);
});

test("our stricter validator never accepts something Better Auth itself rejects", () => {
  // The asymmetry we rely on: Better Auth silently drops entries it cannot parse,
  // so anything we accept that it rejects is a no-op, and anything it accepts
  // that we reject leaves the bucket shared. Neither is a hole — but drift
  // should be noticed.
  const candidates = [
    "10.0.0.1",
    "10.0.0.0/8",
    "192.0.2.128/32",
    "0.0.0.0/0",
    "::/0",
    "::1",
    "2606:4700::/32",
    "::ffff:192.0.2.1",
    "2001:db8:0:0:0:0:2:1",
    "10.0.0.1/33",
    "nope",
    "0.0.0.0",
    "::",
  ];
  for (const entry of candidates) {
    const ours = parseTrustedProxyEntry(entry);
    const theirs = findInvalidTrustedProxies([entry]);
    if (ours !== null) {
      assert.deepEqual(theirs, [], `we accept ${entry} but Better Auth would drop it`);
    }
  }
});

test("the resolved config is de-duplicated, split on any separator, and counted", () => {
  const config = resolveIpAddressConfig({
    BETTER_AUTH_TRUSTED_PROXIES: "10.0.0.0/8, 10.0.0.0/8; 192.0.2.128/32\nnope\t0.0.0.0/0",
  });
  assert.deepEqual(config.trustedProxies, ["10.0.0.0/8", "192.0.2.128/32"]);
  assert.equal(config.rejected, 3, "the duplicate and the two dangerous entries");
  const warning = describeRejectedTrustedProxies(config);
  assert.ok(warning && warning.includes("BETTER_AUTH_TRUSTED_PROXIES"));
  // Never the values: they describe internal network topology.
  for (const secretish of ["10.0.0.0/8", "192.0.2.128/32", "nope", "0.0.0.0/0"]) {
    assert.ok(!warning.includes(secretish), `warning must not echo ${secretish}`);
  }
});

test("an entirely unusable proxy list yields no trust at all, i.e. today's behaviour", () => {
  const config = resolveIpAddressConfig({ BETTER_AUTH_TRUSTED_PROXIES: "0.0.0.0/0, nope" });
  assert.deepEqual(config.trustedProxies, []);
  assert.equal(config.rejected, 2);
});

// --- the sign-up gate is untouched by any of this ----------------------------

test("the sign-up policy still closes by default in production, proxies or no proxies", () => {
  for (const proxies of [undefined, "10.0.0.0/8"]) {
    const policy = resolveSignupPolicy({
      NODE_ENV: "production",
      ...(proxies ? { BETTER_AUTH_TRUSTED_PROXIES: proxies } : {}),
    });
    assert.equal(policy.enabled, false, JSON.stringify(proxies));
  }
  // Configuring proxies is not consent to open sign-up: the master switch and
  // the user-create hook remain the admission control.
  const opened = resolveSignupPolicy({
    NODE_ENV: "production",
    SIGNUP_ENABLED: "true",
    BETTER_AUTH_TRUSTED_PROXIES: "10.0.0.0/8",
  });
  assert.equal(opened.enabled, true);
  assert.equal(resolveSignupPolicy({ NODE_ENV: "production", SIGNUP_ENABLED: "false" }).enabled, false);
});

test("lib/auth.ts wires trustedProxies and none of the three widening options", () => {
  assert.ok(
    authSrc.includes("advanced: {") && authSrc.includes("trustedProxies: ipAddressConfig.trustedProxies"),
    "the resolved proxies must reach advanced.ipAddress.trustedProxies",
  );
  assert.ok(authSrc.includes("resolveIpAddressConfig()"), "the config must come from the gate module");
  assert.ok(authSrc.includes("describeRejectedTrustedProxies"), "bad proxy config must warn the operator");
  assert.ok(!authCode.includes("disableIpTracking"), "disableIpTracking disables rate limiting outright");
  assert.ok(!authCode.includes("ipAddressHeaders"), "header reordering cannot break a multi-hop tie and is forgeable");
  assert.ok(!authCode.includes("customRules"), "a rule is resolved after the bucket key and cannot re-key it");
  assert.ok(!authCode.includes("rateLimit:"), "no rateLimit block: any value here is a no-op or a wider budget");
  // The admission control must survive the change.
  assert.ok(authSrc.includes("disableSignUp: !signupPolicy.enabled"));
  assert.ok(authSrc.includes("canCreateAccount(user.email, signupPolicy)"));
  assert.ok(!/NEXT_PUBLIC_[A-Z_]*TRUSTED_PROXIES/.test(authSrc), "proxy ranges must stay server-side");
});