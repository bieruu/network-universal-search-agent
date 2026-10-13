/**
 * What each data source contributes, and what the result says when it fails.
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
 * The `whenSlow` half is the product's core honest claim — a gap is never
 * mistaken for good news — so it belongs in one place rather than being
 * re-derived per component.
 */

export interface Source {
  /** The source's own name, as the logo strip prints it. */
  mark: string;
  /** One short clause naming what kind of record this is. */
  detail: string;
  /** What this source contributes to a result, in plain words. */
  gives: string;
  /** What the visitor sees when this source fails — never a silent blank. */
  whenSlow: string;
}

export const SOURCES: readonly Source[] = [
  {
    mark: "shodan",
    detail: "internet-wide service and host data",
    gives:
      "The open ports on a target and the product and version answering on each one, read from internet-wide scan data — nothing on your target is contacted to find out.",
    whenSlow:
      "If Shodan is slow or unreachable, the rest of the result still arrives and the ports card says it could not check — a blank port list is never read as \"nothing is open\".",
  },
  {
    mark: "crt.sh",
    detail: "the public certificate log",
    gives:
      "Machine names under your domain that have ever appeared in a publicly logged TLS certificate — including names nobody ever put on a page.",
    whenSlow:
      "If the certificate log is slow, the rest of the result still arrives and the subdomains card says the log was unreachable, so an empty list is never mistaken for \"no subdomains\".",
  },
  {
    mark: "whois",
    detail: "public domain registration records",
    gives:
      "The registration record behind a domain: who holds it, when it was created, when it expires, and which nameservers answer for it.",
    whenSlow:
      "If the registry does not answer, the rest of the result still arrives and the details card says the record could not be read.",
  },
  {
    mark: "NVD",
    detail: "the NIST vulnerability database",
    gives:
      "Known vulnerabilities matched against the software a source reports running, with severity taken from the NIST vulnerability database.",
    whenSlow:
      "If matching does not complete, the vulnerabilities card says what it could not check rather than presenting an empty list as \"nothing found\".",
  },
];
