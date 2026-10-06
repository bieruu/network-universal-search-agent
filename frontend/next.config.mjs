/** @type {import("next").NextConfig} */

// SHA-256 of the inline theme-bootstrap script in app/layout.tsx. If that
// script changes, recompute with:
//   node -e "const{createHash}=require('crypto'),f=require('fs');const s=f.readFileSync('app/layout.tsx','utf8').match(/__html: `([\s\S]*?)`,\n/)[1];console.log('sha256-'+createHash('sha256').update(s,'utf8').digest('base64'))"
// `npm test` (lib/security-headers.test.ts) fails if this drifts from the script.
// CSP starts as report-only: Next.js also emits inline hydration scripts
// (self.__next_f), so enforcement requires a nonce before flipping.
const THEME_SCRIPT_HASH = "sha256-teEMKbLy9qaiCzLDSHDmAWxSyhs4oGVULwsBSVqD3aA=";

const CSP_REPORT_ONLY = [
  "default-src 'self'",
  `script-src 'self' '${THEME_SCRIPT_HASH}'`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://cdn.simpleicons.org",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

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
          { key: "Content-Security-Policy-Report-Only", value: CSP_REPORT_ONLY },
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
