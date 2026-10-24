import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { GUEST_SCAN_LIMIT_PER_DAY, guestQuotaMessage, isGuestSession } from "./guest.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...parts: string[]) => readFileSync(join(here, ...parts), "utf8");

const proxy = read("..", "app", "api", "scan", "[[...path]]", "route.ts");
const page = read("..", "app", "(dashboard)", "dashboard", "page.tsx");
const shell = read("..", "app", "(dashboard)", "dashboard", "_components", "app-shell.tsx");
const sidebar = read("..", "components", "ui", "app-1-utils", "app-1-sidebar.tsx");
const middleware = read("..", "middleware.ts");
const guestSrc = read("guest.ts");

// The two halves of the guest contract live in two packages. Reading the
// backend's source here is the cheapest thing that can catch one side moving:
// a quota mirrored into UI copy, or a signature algorithm forked.
const backendConfig = read("..", "..", "backend", "app", "core", "config.py");
const backendSecurity = read("..", "..", "backend", "app", "core", "security.py");

/* --------------------------- the reversal itself -------------------------- */

test("the visitor lands on the landing page, never on sign-in", () => {
  // The reported bug: opening the site put a sign-in surface in front of the
  // visitor. Two code paths could do that, and both had to go. The assertions
  // target the ROUTE VALUES, not the words: the explanatory comments in
  // middleware.ts are allowed to keep saying "/sign-in" and "unavailable" so a
  // reader can still learn what was removed and why.
  assert.ok(
    !middleware.includes('"/sign-in"') && !middleware.includes("'/sign-in'"),
    "middleware must not redirect anything to /sign-in (reversal 2026-10-14)",
  );
  assert.ok(
    !middleware.includes("UNAVAILABLE_BODY") && !middleware.includes("unavailable()"),
    "the auth-availability 503 must not be able to refuse the landing page",
  );
  // Logging out is leaving the app, not starting an account.
  for (const [name, src] of [
    ["app-shell.tsx", shell],
    ["app-1-sidebar.tsx", sidebar],
  ] as const) {
    assert.ok(src.includes('router.push("/")'), `${name}: logout must land on the landing page`);
    assert.ok(
      !src.includes('router.push("/sign-in")'),
      `${name}: logout must not land on sign-in (reversal 2026-10-14)`,
    );
  }
});

test("middleware still mints the nonce and hands the CSP to both sides", () => {
  assert.ok(middleware.includes("generateNonce()"), "one nonce per request");
  assert.ok(
    /requestHeaders\.set\(\s*["']content-security-policy["']\s*,\s*policy\s*\)/i.test(middleware),
    "the CSP goes on the request Next renders with",
  );
  assert.ok(
    /response\.headers\.set\(\s*headerName\s*,\s*policy\s*\)/.test(middleware),
    "and on the response the browser enforces",
  );
});

/* ------------------------------ guest identity ---------------------------- */

test("the proxy mints a signed token only when a scan starts", () => {
  assert.ok(proxy.includes('"x-guest-token"'), "the token must be sent to the backend");
  assert.ok(proxy.includes("createHmac"), "the token must be signed, not invented");
  assert.ok(proxy.includes("timingSafeEqual"), "the stored cookie must be re-verified, not trusted");
  assert.ok(proxy.includes("nusa-guest:"), "domain separation must be on the signed message");
  assert.ok(proxy.includes("HttpOnly"), "the guest cookie must be unreadable to scripts");
  assert.ok(proxy.includes("SameSite=Lax"), "the guest cookie must not ride cross-site");
  assert.ok(
    proxy.includes('req.method === "POST" && path.length === 0'),
    "minting must be limited to the call that starts a scan - a poll must not create identities",
  );
  assert.ok(
    proxy.includes('const GUEST_COOKIE = "nusa_guest"'),
    "the cookie name must be a named constant, not a string literal scattered around",
  );
});

test("the signing secret stays server-side", () => {
  // BETTER_AUTH_SECRET may only appear in the proxy route handler. A guest
  // banner, a shell, or a lib module reading it would put the key that mints
  // scan subjects into the browser bundle.
  for (const [name, src] of [
    ["page.tsx", page],
    ["app-shell.tsx", shell],
    ["app-1-sidebar.tsx", sidebar],
    ["lib/guest.ts", guestSrc],
  ] as const) {
    assert.ok(
      !src.includes("BETTER_AUTH_SECRET"),
      `${name} must not read the signing secret (server-only)`,
    );
  }
});

test("both sides agree on the token shape and the signed message", () => {
  // Minter: 16 random bytes as hex. Verifier: `[0-9a-f]{32}`, fullmatch, before
  // the signature is computed. If one side drifts, every guest is a 401.
  const verifier = backendSecurity.match(/_GUEST_ID_PATTERN\s*=\s*re\.compile\(r?"([^"]+)"\)/);
  assert.ok(verifier, "backend must declare _GUEST_ID_PATTERN");
  assert.equal(verifier[1], "[0-9a-f]{32}", "the verifier's id shape changed");
  assert.ok(
    proxy.includes("/^[0-9a-f]{32}\\.[A-Za-z0-9_-]{43}$/"),
    "the proxy must accept exactly that id plus a 43-char base64url signature",
  );
  assert.ok(
    backendSecurity.includes('f"nusa-guest:{guest_id}"'),
    "the verifier must sign the same domain-separated message the proxy does",
  );
  assert.ok(
    backendSecurity.includes('alias="x-guest-token"'),
    "the backend must read the header the proxy sends",
  );
});

test("the mirrored guest quota equals the backend's default", () => {
  const mirror = backendConfig.match(/guest_scan_limit_per_day\s*:\s*int\s*=\s*Field\(default=(\d+)/);
  assert.ok(mirror, "backend default for guest_scan_limit_per_day not found in config.py");
  assert.equal(
    String(GUEST_SCAN_LIMIT_PER_DAY),
    mirror[1],
    "lib/guest.ts quotes a number the backend no longer defaults to - the backend is authoritative, update the mirror",
  );
  // The hard bound is the one a cookie cannot reset; it must exist and ship on.
  const cap = backendConfig.match(/guest_scan_daily_total\s*:\s*int\s*=\s*Field\(default=(\d+)/);
  assert.ok(cap, "the instance-wide guest budget must exist in config.py");
  assert.ok(Number(cap[1]) > 0, "the instance-wide guest budget must ship enabled");
});

/* ------------------------------- guest shell ------------------------------ */

test("isGuestSession only answers once auth has", () => {
  // Shape is Better Auth's `useSession()` result: `isPending` before `data`.
  assert.equal(isGuestSession({ isPending: false, data: null }), true);
  assert.equal(isGuestSession({ isPending: false, data: { user: {}, session: {} } }), false);
  // Still asking: `data` is null here too, so the pending flag is the only
  // thing that stops guest chrome flashing over a signed-in analyst's shell.
  assert.equal(isGuestSession({ isPending: true, data: null }), false);
  assert.equal(isGuestSession(null), false);
});

test("the dashboard explains guest mode instead of hiding the limits", () => {
  assert.ok(page.includes("isGuestSession(sessionState)"), "the page must derive guest state from auth");
  assert.ok(page.includes("GUEST_BANNER_TITLE"), "the guest banner must render");
  assert.ok(page.includes('aria-label="guest mode"'), "the banner must be labelled");
  assert.ok(page.includes("Sign in"), "every limit must come with its way out");
  // The quota 429 replaces lib/user-errors.ts account copy - a guest has no
  // account, so "search limit for your account" would be false.
  assert.ok(page.includes("guestQuotaMessage()"), "a guest 429 must use guest copy");
  assert.ok(
    guestQuotaMessage().includes("Sign in"),
    "the quota message must offer the sign-in path",
  );
  assert.ok(
    !guestQuotaMessage().includes("account"),
    "the quota message must not claim an account the visitor does not have",
  );
});

test("account-only surfaces show the reason, not a failing request", () => {
  // /api/history and /api/trend stay require_user() on the backend. Rendering
  // them anyway would answer a 401 badge (history) or an empty chart (trend)
  // right next to a scan the guest CAN see - the "empty account" bug the copy
  // audit already fixed once.
  assert.ok(page.includes("GUEST_HISTORY_LOCKED"), "the history card must explain itself to guests");
  assert.ok(page.includes("GUEST_TREND_LOCKED"), "the trend card must explain itself to guests");
  // Both components must still be rendered for a signed-in analyst.
  assert.ok(page.includes("<HistoryList onSelect={reopen} limit={5} />"), "history stays for accounts");
  assert.ok(page.includes("<RiskTrendChart target={target} />"), "trend stays for accounts");
  // A guest's own cards stay: the scan, the tables, the export (all client-side
  // over data already on screen).
  for (const kept of ["<PortsTable", "<SubdomainsTable", "<ExportFindingsCard"]) {
    assert.ok(page.includes(kept), `${kept} must not be gated away from guests`);
  }
  // While Better Auth has not answered, neither account-only component may be
  // mounted: both fetch on mount, and a visitor with no session yet would pay
  // for a request that can only come back 401/502. Skeleton instead.
  assert.ok(page.includes("<PendingCard title=\"History\" />"), "history must hold a skeleton while pending");
  assert.ok(page.includes("<PendingCard title=\"Risk trend\" />"), "trend must hold a skeleton while pending");
  assert.ok(page.includes("const authPending = sessionState.isPending"), "pending must come from the session state, not from an absence of data");
});

test("a guest is never offered a logout", () => {
  for (const [name, src] of [
    ["app-shell.tsx", shell],
    ["app-1-sidebar.tsx", sidebar],
  ] as const) {
    assert.ok(src.includes("isGuestSession("), `${name} must detect a guest through lib/guest.ts`);
    assert.ok(
      src.includes("!guest"),
      `${name} must gate the logout control on there being a session`,
    );
  }
});
