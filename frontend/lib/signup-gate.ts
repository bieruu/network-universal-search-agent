/**
 * Self-service sign-up gate.
 *
 * Why this exists: the backend scan quota (`RATE_LIMIT_PER_HOUR`, default and
 * production maximum 5) is counted **per user**, so N self-service accounts
 * == N x 5 scans/hour against a single paid Shodan key. That is a cost vector,
 * not an auth bypass, so the fix is an admission control decision, not a token fix.
 *
 * Two independent knobs, both env-driven so ops never needs a code change:
 *   SIGNUP_ENABLED         - master switch. Unset => closed in production,
 *                            open in dev/test so the documented local flow
 *                            keeps working. Anything unparseable is treated as
 *                            unset, which is fail-closed under production.
 *   SIGNUP_EMAIL_ALLOWLIST - optional comma/semicolon/space separated list.
 *                            Empty => no allowlist (any email may register).
 *                            Entries may be `user@example.com`, `@example.com`,
 *                            `*@example.com` or the bare `example.com`
 *                            (whole domain). Matches are case-insensitive.
 *
 * A third knob, `BETTER_AUTH_TRUSTED_PROXIES`, belongs here for the same
 * reason: it decides whether Better Auth's rate limiter can tell callers apart
 * at all, which is the other half of protecting self-service sign-up. See
 * "Client-IP resolution" at the bottom of this file.
 *
 * This module is deliberately dependency-free and synchronous so it can be
 * unit-tested without a database, a session, or the network.
 */

export type SignupEnv = Record<string, string | undefined>;

export type SignupAllowlist = {
  /** Fully-qualified, lower-cased addresses. */
  emails: Set<string>;
  /** Lower-cased domains; any address in one of these domains is allowed. */
  domains: Set<string>;
};

export type SignupPolicy = {
  /** Master switch: may new accounts be created at all? */
  enabled: boolean;
  /** True when an allowlist is configured and therefore narrows `enabled`. */
  restricted: boolean;
  allowlist: SignupAllowlist;
};

const TRUE_VALUES = new Set(["1", "true", "yes", "on", "enabled"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off", "disabled"]);

/** `true`/`false` when the value is an unambiguous boolean, else `null` (unset). */
export function parseBooleanFlag(raw: string | undefined): boolean | null {
  if (raw === undefined) return null;
  const value = raw.trim().toLowerCase();
  if (value === "") return null;
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  return null;
}

export function isSelfServiceSignupEnabled(env: SignupEnv = process.env): boolean {
  const explicit = parseBooleanFlag(env.SIGNUP_ENABLED);
  if (explicit !== null) return explicit;
  // Fail closed under production: a deploy that forgets to opt in must not
  // silently expose the Shodan-backed quota to the public internet.
  return (env.NODE_ENV ?? "") !== "production";
}

export function parseSignupAllowlist(raw: string | undefined): SignupAllowlist {
  const emails = new Set<string>();
  const domains = new Set<string>();
  for (const entry of (raw ?? "").split(/[\s,;]+/)) {
    const token = entry.trim().toLowerCase();
    if (!token) continue;
    if (token.startsWith("*@")) {
      domains.add(token.slice(2));
      continue;
    }
    if (token.startsWith("@")) {
      domains.add(token.slice(1));
      continue;
    }
    if (!token.includes("@")) {
      domains.add(token);
      continue;
    }
    emails.add(token);
  }
  return { emails, domains };
}

export function isSignupEmailAllowed(
  email: string | null | undefined,
  allowlist: SignupAllowlist,
): boolean {
  // No allowlist configured => every email is admissible; `enabled` alone decides.
  if (allowlist.emails.size === 0 && allowlist.domains.size === 0) return true;
  if (typeof email !== "string") return false;
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at <= 0 || at === normalized.length - 1) return false;
  if (allowlist.emails.has(normalized)) return true;
  return allowlist.domains.has(normalized.slice(at + 1));
}

export function resolveSignupPolicy(env: SignupEnv = process.env): SignupPolicy {
  const allowlist = parseSignupAllowlist(env.SIGNUP_EMAIL_ALLOWLIST);
  return {
    enabled: isSelfServiceSignupEnabled(env),
    restricted: allowlist.emails.size > 0 || allowlist.domains.size > 0,
    allowlist,
  };
}

/**
 * The single server-side admission decision for creating a brand-new account.
 *
 * This is enforced from `databaseHooks.user.create.before` in `lib/auth.ts`,
 * which Better Auth runs for BOTH the email/password sign-up endpoint and
 * OAuth account creation, so it cannot be side-stepped with "Continue with
 * Google". Returning `false` aborts the insert before any row is written.
 * Existing accounts are untouched — only creation is gated.
 */
export function canCreateAccount(
  email: string | null | undefined,
  policy: SignupPolicy,
): boolean {
  if (!policy.enabled) return false;
  return isSignupEmailAllowed(email, policy.allowlist);
}

export const SIGNUP_CLOSED_TITLE = "Sign-up is closed";

export function signupClosedBody(policy: SignupPolicy): string {
  // "Deployment" is infrastructure vocabulary; nobody signing in has a concept
  // for it. Both variants must still say what to do next, and must not reveal
  // whether an allowlist is configured beyond what the page already shows.
  if (policy.restricted) {
    return "Creating a new account here needs approval. Ask an administrator to set up your access, then sign in.";
  }
  return "Creating a new account here needs approval. Ask an administrator to set up your access, then sign in.";
}

export const SIGNUP_RESTRICTED_BODY =
  "New accounts are limited to approved email addresses. Use your approved address, or ask an administrator for access.";

/* ------------------------------------------------------------------------- *
 * Client-IP resolution for Better Auth's rate limiter
 * ------------------------------------------------------------------------- */

/**
 * Better Auth rate-limits every request on `${ip}|${path}`. When it cannot
 * resolve a trustworthy client IP it substitutes the literal `no-trusted-ip`,
 * so the whole internet shares one bucket per path. For `/sign-up/*` that
 * bucket is 3 requests / 10 seconds, so a single caller can lock every other
 * caller out — a user-DoS, not an auth bypass, but still an outage.
 *
 * Everything below is a reading of the installed `better-auth@1.7.7` /
 * `@better-auth/core@1.7.7`; `lib/auth-rate-limit.test.ts` imports those
 * packages directly and pins each claim, so an upgrade that changes the
 * behaviour fails the suite instead of silently regressing the fix.
 *
 * What is left undone, and why nothing here can undo it:
 *
 *  - `x-forwarded-for` longer than one hop, with no `trustedProxies`, resolves
 *    to `null` by design (the leftmost token is client-spoofable). In production
 *    there is no localhost fallback, so the bucket really is shared.
 *  - `rateLimit.customRules` cannot help. A rule is only `{ window, max }`,
 *    and the bucket key is computed *before* custom rules are evaluated, so a
 *    rule can never re-key the bucket. Any value is either a no-op, a wider
 *    global budget, or an easier DoS (a *smaller* max means one caller locks
 *    everyone out sooner).
 *  - `advanced.ipAddress.ipAddressHeaders` cannot help either. Reordering only
 *    matters if some other header is single-valued when `x-forwarded-for` is
 *    not, and Vercel's docs describe `x-real-ip` as "identical to the
 *    `x-forwarded-for` header" — so a chain that defeats the default defeats
 *    the alternative too. Preferring it would additionally let a directly
 *    reachable origin mint a fresh bucket per request with a forged header.
 *  - `advanced.ipAddress.disableIpTracking` is strictly worse than doing
 *    nothing: `getIP` then returns `null` unconditionally and Better Auth
 *    skips rate limiting for every path.
 *
 * That leaves `trustedProxies` as the only lever, and it cannot be configured
 * on anyone's behalf: it requires knowing the address of the hop nearest the
 * app, which for Vercel is edge infrastructure Vercel does not publish. So it
 * stays unset unless an operator asserts their own topology, and the entries
 * are validated strictly here because a too-broad entry silently converts the
 * limiter into no limiter.
 */

export type IpAddressConfig = {
  /**
   * Passed verbatim to `advanced.ipAddress.trustedProxies`. Empty means the
   * option is left unset, which is Better Auth's own fail-closed default.
   */
  trustedProxies: string[];
  /**
   * How many operator-supplied entries were rejected. A count only — proxy
   * addresses describe internal network topology and are never logged.
   */
  rejected: number;
};

/** Conservative IPv4 quad check: four decimal octets, no leading-zero tricks. */
function isIPv4Literal(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255);
}

/**
 * Conservative IPv6 check. It only has to be safe, not exhaustive: an entry
 * this accepts but Better Auth rejects is silently dropped by Better Auth
 * (`trustedProxies.map(parseCIDR).filter(...)`), and an entry this rejects but
 * Better Auth accepts leaves the bucket shared, i.e. today's behaviour. Both
 * failures land on the safe side.
 */
function isIPv6Literal(value: string): boolean {
  if (!value.includes(":") || value.includes(":::")) return false;
  const compressions = value.split("::").length - 1;
  if (compressions > 1) return false;
  const [left, right] = value.split("::");
  const groups = [left, right].filter((side) => side !== undefined && side !== "");
  // A trailing IPv4 form ("::ffff:192.0.2.1") counts as two groups.
  let count = 0;
  for (const side of groups) {
    const parts = side.split(":");
    for (const [index, part] of parts.entries()) {
      const isLast = index === parts.length - 1;
      if (isLast && part.includes(".")) {
        if (!isIPv4Literal(part)) return false;
        count += 2;
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(part)) return false;
      count += 1;
    }
  }
  return compressions === 1 ? count < 8 : count === 8;
}

/**
 * Normalizes one `BETTER_AUTH_TRUSTED_PROXIES` entry, or returns `null` when
 * it must not be trusted. Beyond syntax this rejects anything that would make
 * the limiter trust a client-controlled value: a prefix of 0 (and a bare
 * `0.0.0.0` / `::`) matches every address, which walks the chain all the way
 * to the leftmost, spoofable token.
 */
export function parseTrustedProxyEntry(raw: string): string | null {
  const entry = raw.trim().toLowerCase();
  if (!entry) return null;
  const slash = entry.lastIndexOf("/");
  const host = slash === -1 ? entry : entry.slice(0, slash);
  const isV4 = isIPv4Literal(host);
  const isV6 = !isV4 && isIPv6Literal(host);
  if (!isV4 && !isV6) return null;
  const maxBits = isV4 ? 32 : 128;
  if (slash === -1) {
    if (isV4 ? host === "0.0.0.0" : host === "::") return null;
    return host;
  }
  const digits = entry.slice(slash + 1);
  if (!/^\d+$/.test(digits)) return null;
  const prefix = Number(digits);
  if (prefix > maxBits || prefix === 0) return null;
  return `${host}/${prefix}`;
}

/**
 * Resolves `advanced.ipAddress` from the environment.
 *
 * Default is an empty list, i.e. Better Auth's own behaviour: unresolved IP
 * becomes the shared `no-trusted-ip` bucket. Nothing here widens the attacker's
 * budget on its own — the only way a forwarded chain becomes trusted is for an
 * operator to name the hops they actually operate.
 */
export function resolveIpAddressConfig(env: SignupEnv = process.env): IpAddressConfig {
  const trustedProxies: string[] = [];
  let rejected = 0;
  const seen = new Set<string>();
  for (const entry of (env.BETTER_AUTH_TRUSTED_PROXIES ?? "").split(/[\s,;]+/)) {
    if (!entry.trim()) continue;
    const parsed = parseTrustedProxyEntry(entry);
    if (!parsed || seen.has(parsed)) {
      rejected += 1;
      continue;
    }
    seen.add(parsed);
    trustedProxies.push(parsed);
  }
  return { trustedProxies, rejected };
}

/**
 * Operator-facing warning for entries that were dropped, or `null` when the
 * configuration is clean. Counts only — never the values.
 */
export function describeRejectedTrustedProxies(config: IpAddressConfig): string | null {
  if (config.rejected === 0) return null;
  const verb = config.rejected === 1 ? "entry was" : "entries were";
  return (
    `BETTER_AUTH_TRUSTED_PROXIES: ${config.rejected} ${verb} rejected as unusable ` +
    "(not a valid IP/CIDR, prefix out of range, or a range covering every address). " +
    "They were ignored; client IPs that cannot be resolved share one rate-limit bucket."
  );
}