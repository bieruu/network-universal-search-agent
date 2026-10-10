/**
 * Static, fabricated scan output for the landing page's signed-out playground.
 *
 * A signed-out visitor can type a command and press scan. That scan CANNOT hit
 * the network, and that is a deliberate design decision rather than a missing
 * feature:
 *
 *   - There is no anonymous scan endpoint. Every scan route calls
 *     `require_user()` (AGENTS.md 5.2), so an anonymous path would have to be
 *     a new, deliberately weaker surface.
 *   - Shodan is queried with ONE shared paid API key, metered by
 *     `RATE_LIMIT_PER_HOUR` (AGENTS.md 5.5). If anonymous traffic could reach
 *     it, anyone on the internet could spend that key on scans they never
 *     pay for.
 *
 * So the playground answers from the samples in `playground-samples.ts` and
 * nothing else — the same three the hero terminal replays while nobody is in a
 * session, so what a visitor gets from `scan` here is exactly what they just
 * watched on the static hero.
 *
 * THE HONESTY RULE: a simulated result must never be mistakable for a real one.
 * Every number in the samples is invented. The terminals that render it must
 * print `DEMO_NOTICE` immediately above this output, print `DEMO_LIST_NOTICE` at
 * the bottom of `list`, and show a DEMO/LIVE caption so the state is always
 * visible. If a future change makes that output read like a live scan, it has
 * broken the one property that makes the playground acceptable. Do not soften
 * these notices, do not make them cute, and do not quietly swap a sample for a
 * real API call. If a real scan should be offered signed-out, that is an auth
 * and rate-limit decision to make deliberately, not a change to this file.
 *
 * Plain data plus two tiny pure functions. No React, no imports beyond the
 * shared samples.
 */

import { DEMO_SCANS } from "./playground-samples";

export interface DemoTarget {
  /** The domain as it appears in the list and in the echoed command. */
  target: string;
  /** One short line explaining why this target is worth looking at. */
  blurb: string;
  /** The four output lines, identical to the static hero's sample. */
  output: string[];
}

/**
 * The one-line "why look at this" note under each target in `list`.
 *
 * Keyed by target so adding a sample without a note is a type error rather than
 * a blank row in the list.
 */
const BLURBS: Record<string, string> = {
  "example.com": "The reserved example domain. Small, and honest about it.",
  "api.acme.co": "A deeper subdomain, so the certificate list gets longer.",
  "portal.nova.io": "A second registrable domain, with a different registrar.",
};

export const DEMO_TARGETS: readonly DemoTarget[] = DEMO_SCANS.map((scan) => ({
  target: scan.target,
  blurb: BLURBS[scan.target] ?? "",
  output: scan.output,
}));

/**
 * Exact lookup only. Trims and lowercases so `Wikipedia.ORG` resolves, then
 * returns the fixture or `null`. Never fuzzy-matches and never matches a
 * substring: the caller turns `null` into "sign in to scan any domain", so a
 * loose match here would hand a visitor output for a domain they never asked
 * about.
 */
export function findDemoTarget(input: string): DemoTarget | null {
  if (typeof input !== "string") return null;
  const wanted = input.trim().toLowerCase();
  if (!wanted) return null;
  return DEMO_TARGETS.find((t) => t.target === wanted) ?? null;
}

/** Printed immediately above any simulated output. Keep it under about 70 characters. */
export const DEMO_NOTICE = "Simulated output from static fixtures. Not a live scan.";

/** Printed at the bottom of `list`. */
export const DEMO_LIST_NOTICE =
  "Simulated fixtures. Sign in to run real scans on any domain.";

/** Appended when a signed-out visitor asks for a target outside the demo list. */
export const DEMO_SIGN_IN_HINT = "Sign in to run a real scan against any domain.";