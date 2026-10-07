import { betterAuth } from "better-auth";
import { Pool } from "pg";
import {
  canCreateAccount,
  describeRejectedTrustedProxies,
  resolveIpAddressConfig,
  resolveSignupPolicy,
} from "./signup-gate.ts";

const databaseUrl = process.env.DATABASE_URL;
const secret = process.env.BETTER_AUTH_SECRET;
const baseURL = process.env.BETTER_AUTH_URL ?? process.env.NEXT_PUBLIC_APP_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to run Better Auth");
}
if (
  !secret ||
  secret.length < 32 ||
  /^(replace-with|change-me|dev-secret|your-secret)/i.test(secret)
) {
  throw new Error("BETTER_AUTH_SECRET must be a non-default secret of at least 32 characters");
}
if (!baseURL) {
  throw new Error("BETTER_AUTH_URL is required to run Better Auth");
}

const socialProviders = {
  ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    ? {
        google: {
          clientId: process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        },
      }
    : {}),
  ...(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
    ? {
        github: {
          clientId: process.env.GITHUB_CLIENT_ID,
          clientSecret: process.env.GITHUB_CLIENT_SECRET,
        },
      }
    : {}),
};

// Admission control for self-service sign-up. `signupPolicy` is resolved once
// at module load, matching how the rest of this module reads the environment.
//
// `disableSignUp` alone would be insufficient: it only short-circuits the
// email/password endpoint (Better Auth rejects it with
// EMAIL_PASSWORD_SIGN_UP_DISABLED) while `sign-in.social` still mints accounts
// from a Google/GitHub profile. The `user.create.before` hook is the only
// single choke point that covers every creation path, so it is the real gate.
const signupPolicy = resolveSignupPolicy();

// Better Auth rate-limits on `${ip}|${path}` and falls back to the literal
// `no-trusted-ip` when it cannot resolve a trustworthy client IP, which makes
// every caller share one bucket — 3 requests / 10 seconds on `/sign-up/*`, so
// one caller could lock out every other caller. `trustedProxies` is the only
// option in better-auth 1.7.7 that resolves a multi-hop `x-forwarded-for`, and
// it can only be set by an operator who knows their own topology, so it stays
// unset otherwise. See the "Client-IP resolution" section of `signup-gate.ts`
// for the full reading of the installed code and for why the three alternative
// options are deliberately not configured.
const ipAddressConfig = resolveIpAddressConfig();
const rejectedProxyWarning = describeRejectedTrustedProxies(ipAddressConfig);
if (rejectedProxyWarning) {
  // Count only; proxy ranges describe internal topology and are never logged.
  console.warn(rejectedProxyWarning);
}

export const auth = betterAuth({
  database: new Pool({ connectionString: databaseUrl }),
  secret,
  baseURL,
  trustedOrigins: [baseURL],
  emailAndPassword: { enabled: true, disableSignUp: !signupPolicy.enabled },
  socialProviders,
  // `ipAddressHeaders`, `disableIpTracking` and `rateLimit.customRules` are
  // intentionally absent. Preferring a different IP header cannot break a
  // multi-hop tie (Vercel documents `x-real-ip` as identical to
  // `x-forwarded-for`) and would let a directly reachable origin forge a bucket;
  // `disableIpTracking` disables rate limiting outright; `customRules` is
  // resolved after the bucket key exists and so cannot re-key it.
  advanced: {
    ipAddress: { trustedProxies: ipAddressConfig.trustedProxies },
  },
  databaseHooks: {
    user: {
      create: {
        // Returning `false` aborts the insert before any row is written;
        // Better Auth then surfaces a 400 instead of a session.
        before: async (user) => {
          if (!canCreateAccount(user.email, signupPolicy)) return false;
        },
      },
    },
  },
});
