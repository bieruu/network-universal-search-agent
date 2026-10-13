/** @type {import("next").NextConfig} */

// The CSP is NOT set here. It moved to `middleware.ts`, which mints a fresh
// 128-bit nonce per request and applies the policy on both the request
// hand-off and the response.
//
// Why it cannot live in a static `headers()` block: Next.js emits inline
// hydration scripts (`self.__next_f`, the prefetch bootstrap, anything pushed
// in through `ServerInsertedHTML`) whose bytes depend on the props of the page
// being rendered. No static allowlist can name them — a hash goes stale the
// moment any page's data changes, and `'unsafe-inline'` would make the policy
// decorative. A nonce is the only source that scales: Next reads it back out
// of the request's own policy header and stamps every script it emits with
// it, so `app/layout.tsx` only has to carry `nonce={nonce}` on its own inline
// theme bootstrap.
//
// In development the policy is sent report-only (`cspHeaderName`), because
// `next dev` injects extra bootstrap that the nonce path does not always reach
// and a false-positive there looks like a bug in the app.

const nextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: process.cwd(),
  images: {
    remotePatterns: [{ protocol: "https", hostname: "cdn.simpleicons.org" }],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
        ],
      },
    ];
  },
};
export default nextConfig;
