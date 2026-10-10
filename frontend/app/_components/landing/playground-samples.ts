/**
 * The three demo scans shown on the landing page, and the ONLY place they
 * exist.
 *
 * WHY THIS IS SHARED
 * ------------------
 * The same three samples are used twice: they are what the hero terminal
 * replays while nobody is in a session (the attract loop), and they are what a
 * signed-out visitor gets when they type `scan <target>` in the playground.
 * Those two were separate copies of the same data, which is a drift trap — an
 * edit to one silently made the playground disagree with the static hero. One
 * export, both consumers, no way for them to diverge.
 *
 * WHY THESE TARGETS
 * -----------------
 * `example.com`, `api.acme.co` and `portal.nova.io` are IANA-reserved and
 * invented names. That is the point: every number below is fabricated, so it
 * must never be attributed to a real organisation. Simulated output about
 * wikipedia.org or github.com would be invented claims about companies that
 * exist, which is a different and much worse thing to publish.
 *
 * The wording matches the shapes a real scan renders — source, count, issuer —
 * so the playground demonstrates the product's output format without inventing
 * facts about anyone.
 */

export interface ScanSample {
  /** The full command line as the terminal shows it, e.g. `scan example.com`. */
  command: string;
  /** Just the domain, for the target list and for looking a sample up. */
  target: string;
  /** The four output lines, in the order a real result prints them. */
  output: string[];
}

export const DEMO_SCANS: readonly ScanSample[] = [
  {
    command: "scan example.com",
    target: "example.com",
    output: [
      "shodan  passive source · 2 ports seen",
      "crt.sh  3 cert names · issuer letsencrypt",
      "whois   registrar reserved · emails redacted",
      "risk    heuristic match · status partial",
    ],
  },
  {
    command: "scan api.acme.co",
    target: "api.acme.co",
    output: [
      "shodan  passive source · 6 ports seen",
      "crt.sh  12 names found · issuer sectigo",
      "whois   registrar namecheap · ns 3 found",
      "risk    heuristic match · status elevated",
    ],
  },
  {
    command: "scan portal.nova.io",
    target: "portal.nova.io",
    output: [
      "shodan  passive source · 8 ports seen",
      "crt.sh  9 names found · issuer digicert",
      "whois   registrar cloudflare · emails masked",
      "risk    heuristic match · status monitored",
    ],
  },
];