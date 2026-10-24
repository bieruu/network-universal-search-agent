/**
 * What each data source contributes, and the part of the report it fills.
 *
 * WHY THIS IS SHARED
 * ------------------
 * This copy lived inline in `LogoStrip.tsx`, where the four sources answer with
 * it when a visitor clicks one. The right-hand panel of `HowItWorks` needed the
 * same sentences to replace three fake pills that pretended to be a content
 * list, and it needed them for all four sources at once rather than one at a
 * time.
 *
 * Two copies would have been the drift trap this project already knows about
 * (`playground-samples.ts` exists for exactly this reason): one half edited, the
 * other half quietly still describing the old behaviour. So the sentences are
 * declared once here and both surfaces read them.
 *
 * The logo strip's answer panel shows `gives` alone, one line per source saying
 * what it contributes. `HowItWorks` shows `result` + `outcome`, the row's part
 * of the report and what the visitor gets from it.
 *
 * COPY LIMITS (DESIGN.md): `gives` <= 12 words, `outcome` <= 12 words,
 * `result` <= 4 words, `detail` <= 18 words. `lib/copy-rules.test.ts` enforces
 * them.
 */

export interface Source {
  /** The source's own name, as the logo strip prints it. */
  mark: string;
  /** One short clause naming what kind of record this is. */
  detail: string;
  /** What this source contributes to a result, in plain words. */
  gives: string;
  /** The part of the report this source fills. At most four words. */
  result: string;
  /** What the visitor gets from that part, in one short line. */
  outcome: string;
}

export const SOURCES: readonly Source[] = [
  {
    mark: "shodan",
    detail: "public scan records",
    gives: "Open ports and the software running on them.",
    result: "Open ports",
    outcome: "Which ports answer, and what runs on them.",
  },
  {
    mark: "crt.sh",
    detail: "public certificate log",
    gives: "Subdomains that appear in public certificates.",
    result: "Subdomains",
    outcome: "Names under the domain from public certificates.",
  },
  {
    mark: "whois",
    detail: "public registration record",
    gives: "Who registered the domain, and when it expires.",
    result: "Domain details",
    outcome: "Who registered it, and when it expires.",
  },
  {
    mark: "NVD",
    detail: "public vulnerability database",
    gives: "Known vulnerabilities in the software we find.",
    result: "Known issues",
    outcome: "Weak spots in the software we find.",
  },
];
