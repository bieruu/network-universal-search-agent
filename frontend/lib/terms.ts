/**
 * Single source of truth for how each security concept is named in the UI.
 *
 * Two rules the copy audit (2026-10-10) forced on this product:
 *
 *  1. Lead with what the concept gives the user, not how it is implemented.
 *     "WHOIS record" -> "Domain details"; the term stays available as `short`
 *     so precision is never lost, only demoted.
 *  2. Never delete a security term (CVE, CVSS, NVD, CPE). These are what an
 *     analyst greps for. Where we use a plainer label, the original acronym
 *     moves into `note` and renders in the collapsible glossary on the card.
 *
 * Every user-facing label must come from here. If a component hardcodes a term
 * that exists below, that is the bug this file exists to prevent.
 */

export interface Term {
  /** What the UI calls it. Plain language, benefit-first. */
  label: string;
  /** The precise security term, shown in the glossary. */
  short: string;
  /** One line explaining the term. Rendered inside <details> glossaries. */
  note: string;
}

export const TERM = {
  ports: {
    label: "Open ports",
    short: "open ports",
    note: "A port is a numbered door into a computer. A port is 'open' when something answers on it from the internet.",
  },
  services: {
    label: "Services",
    short: "services",
    note: "The software running behind each open port, with its version number when it is advertised.",
  },
  banner: {
    label: "Service response",
    short: "banner",
    note: "The short text a server sends back when you connect, before you log in. It often reveals the product and version.",
  },
  subdomains: {
    label: "Subdomains",
    short: "subdomains",
    note: "Names under your root domain, such as api.example.com. Each one is a machine that can be reachable on its own.",
  },
  issuer: {
    label: "Certificate issuer",
    short: "issuer",
    note: "The company that signed the TLS certificate for that subdomain.",
  },
  whois: {
    label: "Domain details",
    short: "WHOIS",
    note: "The public registration record for a domain: who registered it, when it was created, when it expires, and which nameservers answer for it.",
  },
  registrant: {
    label: "Registered with",
    short: "registrar",
    note: "The company that holds the domain registration on someone's behalf.",
  },
  nameservers: {
    label: "Nameservers",
    short: "NS",
    note: "The servers that translate a domain name into an IP address. Their hostnames are usually visible to anyone.",
  },
  risk: {
    label: "Risk score",
    short: "heuristic",
    note: "A 0-100 summary built from the findings above. It is a sorting aid for where to look first, not a verdict on whether the host is safe.",
  },
  cves: {
    label: "Known vulnerabilities",
    short: "CVE",
    note: "A public catalogue of published software vulnerabilities. A CVE id names one entry in that catalogue.",
  },
  cvss: {
    label: "Severity score",
    short: "CVSS",
    note: "The official severity score for a CVE, from 0 (harmless) to 10 (critical).",
  },
  cpe: {
    label: "Detected product",
    short: "CPE",
    note: "The standard identifier for a specific product and version. It is how we check a running service against the vulnerability catalogue.",
  },
  nvd: {
    label: "Vulnerability database",
    short: "NVD",
    note: "The NIST National Vulnerability Database, the public source we check detected products against.",
  },
  tlp: {
    label: "Sharing restriction",
    short: "TLP",
    note: "A traffic-light marking the publisher put on a record to say how widely it may be shared.",
  },
} as const satisfies Record<string, Term>;

export type TermKey = keyof typeof TERM;

/**
 * Explains an unfamiliar word the first time it appears, then stays out of the
 * way. Returns null when the term needs no gloss, so callers can omit the
 * explanation entirely rather than render an empty one.
 */
export function termNote(key: TermKey): string {
  return TERM[key].note;
}

/** Expand a leading verb phrase into a complete, translatable sentence. */
export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/**
 * Hide the registrable part of a domain before it reaches a public page.
 *
 * A signed-in analyst's scan targets can be internal client domains, and the
 * landing terminal renders into HTML that a CDN is free to cache. Results stay
 * useful (counts, risk, open ports); only the identifying name is reduced.
 *
 * `acme-corp-internal.co.uk` -> `a***.co.uk`
 * `192.0.2.10`                -> `192.0.2.*`
 * `localhost`                 -> `localhost` (already blocked upstream)
 */
export function maskTarget(target: string): string {
  const t = target.trim();
  if (!t) return t;

  // IPv4: keep the network, drop the host octet.
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(t)) {
    const parts = t.split(".");
    return `${parts.slice(0, 3).join(".")}.*`;
  }

  // IPv6 and anything else: keep nothing identifying.
  if (t.includes(":")) return "***";

  const labels = t.split(".");
  // A bare hostname ("intranet") has no registrable part to anchor to.
  if (labels.length < 2) return "***";

  const first = labels[0];
  const rest = labels.slice(1).join(".");
  return `${first.slice(0, 1)}***.${rest}`;
}