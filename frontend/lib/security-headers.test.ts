import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (...segments: string[]) => readFileSync(join(root, ...segments), "utf8");

const layout = read("app", "layout.tsx");
const middleware = read("middleware.ts");
const config = read("next.config.mjs");
const csp = read("lib", "csp.ts");

// The old design hashed the one inline script we write and shipped the whole
// policy as Content-Security-Policy-Report-Only, i.e. no enforcement at all.
// The new design mints a nonce per request in middleware, hands it to the
// render through `x-nonce`, and lets Next stamp its own inline scripts with it.
// These tests pin that wiring, because every part of it fails silently: a
// missing nonce only shows up as scripts that never run.
test("the inline theme script survives an enforcing CSP", () => {
  const script = layout.match(/dangerouslySetInnerHTML=\{\{\s*__html: `([\s\S]*?)`/);
  assert.ok(script, "inline theme script not found in app/layout.tsx");
  // The script body must stay exactly what it was — it is the theme bootstrap,
  // and editing it while pinning a hash is how a FOUC regression ships.
  assert.ok(
    script[1].includes("document.documentElement.classList.toggle('dark', isDark)"),
    "the theme bootstrap body looks rewritten",
  );
  // `nonce={nonce}` on the <script> tag is what lets it run at all under the
  // new policy; without it the page would flash the light theme on load.
  const tag = layout.match(/<script[^>]*nonce=\{nonce\}/);
  assert.ok(tag, "app/layout.tsx must pass nonce={nonce} to the inline script");
  assert.ok(
    /<script[\s\S]*?nonce=\{nonce\}[\s\S]*?dangerouslySetInnerHTML/.test(layout),
    "nonce must be on the same <script> tag as the inline body",
  );
});

test("the layout reads the nonce from the middleware's request header", () => {
  assert.ok(layout.includes('from "next/headers"'), "must import headers() from next/headers");
  assert.ok(
    /const nonce = \(await headers\(\)\)\.get\("x-nonce"\)/.test(layout),
    "the nonce must be read from the x-nonce request header",
  );
});

test("the CSP is set on both the request and the response hand-off", () => {
  // Request side: Next reads the nonce back out of the request's
  // content-security-policy header and stamps the scripts it emits.
  assert.ok(
    /requestHeaders\.set\(\s*["']content-security-policy["']\s*,\s*policy\s*\)/i.test(middleware),
    "middleware must put the CSP on the request headers it forwards",
  );
  assert.ok(
    /NextResponse\.next\(\{\s*request:\s*\{\s*headers:\s*requestHeaders\s*\}\s*\}\)/.test(middleware),
    "middleware must forward the request headers through NextResponse.next",
  );
  // Response side: the policy the browser actually enforces. Every response
  // leaves through one helper, including the redirect and the 503.
  assert.ok(
    /response\.headers\.set\(\s*headerName\s*,\s*policy\s*\)/.test(middleware),
    "middleware must put the CSP on the response it returns",
  );
  assert.ok(
    /unavailable\(\)/.test(middleware) && /send\(unavailable\(\)\)/.test(middleware),
    "the refusal branches must carry the CSP too",
  );
  assert.ok(
    /send\(redirectToSignIn\(req\)\)/.test(middleware),
    "the sign-in redirect must carry the CSP too",
  );
});

test("the header name comes from the environment, and only prod enforces", () => {
  assert.ok(
    /cspHeaderName\(/.test(middleware),
    "the header name must be derived through cspHeaderName(isProduction)",
  );
  assert.ok(
    /const isProduction = process\.env\.NODE_ENV === "production"/.test(middleware),
    "production must be detected from NODE_ENV before the header name is chosen",
  );
  // Enforcement off production is dev-only. Neither may be hardcoded here:
  // lib/csp.ts owns "content-security-policy" vs the report-only spelling, and
  // the whole point of VULN-002 is that production must stop being report-only.
  assert.ok(
    !/content-security-policy-(report-only|report_only)/i.test(middleware),
    "middleware must not spell out policy headers itself",
  );
});

test("x-nonce never reaches the response", () => {
  // It is only meaningful server-side; echoing it to the browser would hand an
  // attacker the exact value needed to forge the next request's script.
  assert.ok(
    /x-nonce/.test(middleware),
    "sanity: the nonce channel must exist at all",
  );
  assert.ok(
    !/response\.headers\.set\(\s*["']x-nonce["']/i.test(middleware),
    "x-nonce must stay on the request side only",
  );
});

test("the matcher covers pages but skips the JSON proxies", () => {
  const matcher = middleware.match(/matcher:\s*\[([\s\S]*?)"([^"]+)"/);
  assert.ok(matcher, "matcher config not found in middleware.ts");
  const pattern = matcher[2];
  assert.ok(pattern.startsWith("/"), "Next requires the matcher pattern to start with /");
  // A pattern that does not compile would take the whole middleware down, so
  // this compiles the pattern we actually wrote. It is a sanity check on the
  // regex, not a reimplementation of Next's matcher compiler.
  const compiled = new RegExp(`^${pattern}$`);
  for (const path of ["/", "/sign-in", "/dashboard", "/dashboard/anything", "/sign-up"]) {
    assert.ok(compiled.test(path), `matcher must match ${path}`);
  }
  for (const path of [
    "/api/scan",
    "/api/scan/target/example.com",
    "/api/analysis/headers",
    "/_next/static/chunks/main.js",
    "/favicon.ico",
  ]) {
    assert.ok(!compiled.test(path), `matcher must not match ${path}`);
  }
});

test("next.config.mjs no longer ships a CSP", () => {
  // The policy is per-request now; a static copy here would enforce a
  // nonce-less set of rules over the top of the middleware's and break every
  // inline script on the very first render.
  assert.ok(
    !/Content-Security-Policy/i.test(config),
    "next.config.mjs must not set any CSP header — middleware owns it",
  );
  assert.ok(
    !/sha256-/i.test(config),
    "the old script hash is dead weight and must not be left behind",
  );
});

test("the baseline headers still apply to every route", () => {
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
    "script-src 'self' 'nonce-",
  ]) {
    assert.ok(csp.includes(directive), `missing directive: ${directive}`);
  }
  const scriptSrc = csp.match(/script-src[^;\n]*/)?.[0] ?? "";
  // 'unsafe-inline' would make the nonce pointless: the browser would honour
  // any injected inline script instead of only the ones we signed.
  assert.ok(
    !scriptSrc.includes("'unsafe-inline'"),
    `script-src must not allow unsafe-inline: ${scriptSrc}`,
  );
  // 'unsafe-eval' would defeat the point of shipping a CSP at all.
  assert.ok(!csp.includes("unsafe-eval"), "no unsafe-eval");
});

test("the dashboard session gate survived the matcher widening", () => {
  // The matcher now runs middleware over the whole site, so the session lookup
  // got a path guard. The gate itself must stay intact: it is what keeps an
  // anonymous caller out of scans and history.
  assert.ok(
    middleware.includes('req.nextUrl.pathname.startsWith("/dashboard")'),
    "the session fetch must be guarded to /dashboard so the public pages and the JSON proxies do not pay for it",
  );
  assert.ok(
    middleware.includes('new URL("/api/auth/get-session", authBaseURL)'),
    "the get-session fetch must survive",
  );
  assert.ok(middleware.includes('url.pathname = "/sign-in"'), "the /sign-in redirect must survive");
  assert.ok(
    /session\?\.session && session\?\.user/.test(middleware),
    "both halves of the session payload must be checked",
  );
  assert.ok(
    middleware.includes('cache: "no-store"'),
    "the session response must never be cached",
  );
  assert.ok(middleware.includes("UNAVAILABLE_BODY"), "the fail-closed body must survive");
});
