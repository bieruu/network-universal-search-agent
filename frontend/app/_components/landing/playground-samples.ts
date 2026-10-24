/**
 * The three demo scans shown on the landing page, and the ONLY place they
 * exist.
 *
 * WHY THIS IS SHARED
 * ------------------
 * The same three samples are used twice: they are what the hero terminal
 * replays while nobody is in a session (the attract loop), and they are what a
 * signed-out visitor gets when they type `scan <target>` in the playground.
 * Those two were separate copies of the same data, which is a drift trap - an
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
 * The wording matches the shapes a real scan renders - source, count, issuer -
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

/**
 * The numbers a sample reports, read back out of its own output lines.
 *
 * WHY DERIVED AND NOT DECLARED TWICE
 * ----------------------------------
 * The bento visuals used to carry their own hand-written arrays - six grid
 * cells and seven bar heights - that *looked* like the same information the
 * terminal prints and was not. Two sets of numbers for one sample is exactly
 * the drift trap this file was created to end (see the header): editing the
 * terminal output silently left the visuals disagreeing with it.
 *
 * So the figures are parsed out of `output`, the same lines a visitor reads.
 * The consequence is deliberate: if the copy changes so that these patterns
 * stop matching, `sampleMetrics` returns `null` and the visual has to fall
 * back to saying nothing. It cannot invent a number to fill the gap, which is
 * the failure mode a second hand-written array would have had.
 *
 * Invented numbers either way - these are the samples' own, not facts about
 * the reserved names they are attached to.
 */
export interface SampleMetrics {
  /** Ports the sample's Shodan line reports, or `null` if the line no longer says. */
  ports: number | null;
  /** Certificate names the sample's crt.sh line reports, or `null`. */
  certNames: number | null;
}

const PORTS_SEEN = /·\s*(\d+)\s+ports?\s+seen/;
const CERT_NAMES = /(\d+)\s+(?:cert\s+names|names\s+found)/;

export function sampleMetrics(sample: ScanSample): SampleMetrics {
  let ports: number | null = null;
  let certNames: number | null = null;
  for (const line of sample.output) {
    const p = PORTS_SEEN.exec(line);
    if (p) ports = Number(p[1]);
    const c = CERT_NAMES.exec(line);
    if (c) certNames = Number(c[1]);
  }
  return { ports, certNames };
}

/**
 * Every sample with its figures, for consumers that render the whole set.
 * Samples whose lines stopped carrying a number come back with `null` figures
 * rather than being dropped - a missing target is not the same as a target with
 * zero ports, and a visual that quietly omits one invents the difference.
 */
export function demoSampleMetrics(): Array<{ sample: ScanSample; metrics: SampleMetrics }> {
  return DEMO_SCANS.map((sample) => ({ sample, metrics: sampleMetrics(sample) }));
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