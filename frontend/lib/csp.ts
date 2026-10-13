/**
 * Content-Security-Policy construction for the app's per-request nonce.
 *
 * WHY A NONCE AND NOT A HASH
 *     The old policy (`next.config.mjs`) allowed exactly one script by
 *     `sha256` hash and was sent as `Content-Security-Policy-Report-Only`
 *     because Next.js emits inline hydration scripts (`self.__next_f`, the
 *     prefetch bootstrap, `ServerInsertedHTML`) whose bytes are a function of
 *     the props of the page being rendered. A hash cannot cover that, and adding
 *     `'unsafe-inline'` to cover it would make the policy decorative.
 *
 *     A nonce is the only representation that scales: Next.js reads the nonce
 *     back out of the `content-security-policy` request header
 *     (`next/dist/server/app-render/get-script-nonce-from-header.js`) and stamps
 *     every script it emits with it, so the policy can stay strict without
 *     enumerating anything.
 *
 * This module owns the random bytes and the header text so both are testable
 * without a server: `crypto.getRandomValues` is the Web Crypto API, available
 * in the Edge runtime the middleware runs in and in Node alike, and the policy
 * is a pure function of the nonce plus the configured image origins.
 */

/** 16 bytes = 128 bits, base64url-encoded to 22 characters. */
export const NONCE_BYTES = 16;

/**
 * Build the policy string.
 *
 * `reportOnly` is used in development rather than by a separate policy
 * generator: the nonce is still minted and still applied to Next's own scripts,
 * so a violation is observable without quiet-looking breakage while the dev
 * server injects its extra inline bootstrap.
 */
export function contentSecurityPolicy(
  nonce: string,
  options: { reportOnly?: boolean } = {},
): string {
  void options.reportOnly;
  return [
    "default-src 'self'",
    // `'strict-dynamic'` is what lets Next load the rest of its runtime from
    // the scripts it already owns. With it present the browser also ignores any
    // `'unsafe-inline'` or hash source in this directive, so the only thing that
    // can run is a script carrying the nonce or one created by such a script.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    // Styles stay inline-capable: Tailwind's utilities are extracted to a file,
    // but React's `style` prop, styled-jsx and the animation libraries all emit
    // inline style attributes, and there is no nonce mechanism for them.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://cdn.simpleicons.org",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** Header name a given environment should carry the policy under. */
export function cspHeaderName(isProduction: boolean): string {
  // In development Next injects extra inline bootstrap that the nonce path does
  // not always reach, and `react-refresh` reports over a different transport.
  // Shipping an enforcing policy there would break `next dev` in a way that
  // looks like a bug in the app. Report-only still records every violation.
  return isProduction
    ? "content-security-policy"
    : "content-security-policy-report-only";
}

/** Cryptographically random, URL-safe, 22 characters. Never reuses one. */
export function generateNonce(randomBytes: number = NONCE_BYTES): string {
  const bytes = new Uint8Array(randomBytes);
  globalThis.crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * The nonce advertised back to the browser, or `"-"` when there is none.
 *
 * A middleware misconfiguration must not produce a policy that silently drops
 * its nonce source: an empty nonce renders as `'nonce-'`, which matches nothing
 * and blocks every script including Next's own. Falling back to a placeholder
 * keeps the failure loud in the report and consistent between header and render.
 */
export function nonceFromHeader(value: string | null): string {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : "-";
}
