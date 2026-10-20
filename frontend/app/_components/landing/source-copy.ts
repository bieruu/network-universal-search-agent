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
    detail: "public scan records anyone can look up",
    gives:
      "Open ports, and the software answering on each.",
    whenSlow:
      "If Shodan is slow, the ports card says it could not check — an empty list is not proof that nothing is open.",
  },
  {
    mark: "crt.sh",
    detail: "the public certificate log",
    gives:
      "Machine names under your domain that ever appeared in a public certificate.",
    whenSlow:
      "If the certificate log is slow, the subdomains card says it could not check — no names there is not proof none exist.",
  },
  {
    mark: "whois",
    detail: "the public domain registration record",
    gives:
      "Who holds the domain, and when it was created and expires.",
    whenSlow:
      "If the domain record does not answer, the details card says so.",
  },
  {
    mark: "NVD",
    detail: "the public vulnerability database",
    gives:
      "Weak spots in the software the target reports — listed when we can match them.",
    whenSlow:
      "If matching does not complete, the vulnerabilities card says what was not checked.",
  },
];
