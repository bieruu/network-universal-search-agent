/**
 * `/demo`'s report fixtures - one finished report per shared sample target.
 *
 * WHAT THIS FILE IS
 * -----------------
 * `/demo` answers "what does a full report look like?" WITHOUT scanning
 * anything. Every report is assembled from the same static fixtures the
 * landing terminal replays (`app/_components/landing/playground-samples.ts`),
 * plus a small amount of clearly illustrative detail. It makes no request,
 * imports no API client, and cannot grow a fetch: the route is contract-tested
 * for exactly that (`lib/demo-page.test.ts`).
 *
 * THE TWO KINDS OF DATA HERE, AND HOW TO TELL THEM APART
 * -----------------------------------------------------
 * 1. FIXTURE - read out of the sample's own output lines: the four source
 *    lines verbatim, the port count, the certificate-name count, the issuer,
 *    the registrar, the risk status word, the nameserver count. None of it is
 *    recomputed anywhere else. `sampleMetrics` already returns `null` rather
 *    than guess when a line stops carrying a number, and this file follows the
 *    same rule: a gap renders as "not recorded", never as a zero.
 * 2. ILLUSTRATIVE - detail the fixture does not carry (individual subdomain
 *    names, nameserver hostnames). Invented on purpose, about the reserved
 *    targets only, and every surface that renders it says "illustrative -
 *    demo data" beside it. It contains NO invented measurements: no scores, no
 *    dates, no version numbers, no CVE ids. Where the fixture has no number
 *    (individual ports, registration dates, a risk score), the report says so
 *    instead of filling the gap - that is what keeps this a demo rather than a
 *    fabrication.
 *
 * SIMULATED FAILURE: `api.acme.co` carries one scripted source error, because
 * partial failure is a first-class product state and a demo where every source
 * always answers hides it. The message says "simulated" in words; it is never
 * dressed as a real provider error.
 *
 * Pure data + pure functions. No React, no network, no clock.
 */

import {
  DEMO_SCANS,
  sampleMetrics,
  type SampleMetrics,
  type ScanSample,
} from "../_components/landing/playground-samples.ts";
import { TERM } from "../../lib/terms.ts";

export interface DemoSourceError {
  source: string;
  message: string;
}

export interface DemoSourceLine {
  /** The line's short source id, e.g. `shodan` or `crt.sh`. */
  source: string;
  /** Everything after the id, verbatim from the fixture. */
  says: string;
}

export interface DemoReport {
  target: string;
  /** The full command line, e.g. `scan example.com`. */
  command: string;
  /** The sample's output lines, verbatim - the fixture itself. */
  output: string[];
  /** The same lines split into id + text for rendering. */
  lines: DemoSourceLine[];
  /** Counts parsed out of those same lines. `null` = the line no longer says. */
  metrics: SampleMetrics;
  /** The word the fixture's risk line reports, e.g. `elevated`. */
  riskStatus: string | null;
  /** The registrar word the fixture's whois line reports, or `null`. */
  registrar: string | null;
  /** The certificate issuer the fixture's crt.sh line reports, or `null`. */
  issuer: string | null;
  /** Nameserver count in the whois line (`ns 3 found`), or `null` when unrecorded. */
  nameserverCount: number | null;
  /** ILLUSTRATIVE - a handful of names under the reserved target. */
  names: string[];
  /** ILLUSTRATIVE - hostnames, built only when the fixture records a count. */
  nameServers: string[];
  /** SIMULATED - sources scripted to have "not answered" for this demo. */
  errors: DemoSourceError[];
}

/**
 * ILLUSTRATIVE names. Reserved/invented zones only - the same rule the shared
 * samples live by: fabricated output may only ever attach to targets nobody
 * owns. Counts in the table below are deliberately SMALLER than the fixture's
 * name counts (except example.com, where they match), so the page has an
 * honest truncation to state rather than a fake full list.
 */
const ILLUSTRATIVE_NAMES: Record<string, string[]> = {
  "example.com": ["www.example.com", "mail.example.com", "docs.example.com"],
  "api.acme.co": ["www.acme.co", "api.acme.co", "staging.acme.co", "dev.acme.co"],
  "portal.nova.io": ["www.nova.io", "portal.nova.io", "app.nova.io", "mail.nova.io"],
};

/**
 * SIMULATED failures. Only `nvd` is scripted, and only for one target: the
 * fixture's four source lines never contain it, so reporting it as failed
 * contradicts nothing the report shows - the vulnerability card simply moves
 * from its honest empty state to the honest failure state.
 */
const SCRIPTED_ERRORS: Record<string, DemoSourceError[]> = {
  "api.acme.co": [
    {
      source: "nvd",
      message:
        "Simulated for this demo: the vulnerability database did not answer this target.",
    },
  ],
};

/**
 * Friendly names for sources this demo can report as failed - the same words
 * the dashboard prints for them (see `SOURCE_NAMES` in
 * `app/(dashboard)/dashboard/page.tsx`). Kept beside the fixture so the report
 * is self-contained; both maps name the same four sources.
 */
export const DEMO_SOURCE_LABELS: Record<string, string> = {
  shodan: "Internet scan data (Shodan)",
  crtsh: "Certificate logs (crt.sh)",
  whois: "Domain registration records",
  nvd: "The vulnerability database (NVD)",
};

export function demoSourceLabel(id: string): string {
  return DEMO_SOURCE_LABELS[id.toLowerCase()] ?? "A data source";
}

/** `shodan  passive source · 2 ports seen` -> `{ source: "shodan", says: … }`. */
function splitLine(line: string): DemoSourceLine {
  const m = /^(\S+)\s{2,}(.*)$/.exec(line);
  return m ? { source: m[1], says: m[2] } : { source: line, says: "" };
}

function matchWord(line: string | null | undefined, pattern: RegExp): string | null {
  if (!line) return null;
  const m = pattern.exec(line);
  return m ? m[1] : null;
}

const ISSUER = /issuer\s+([a-z0-9.-]+)/i;
const REGISTRAR = /registrar\s+([a-z0-9.-]+)/;
const RISK_STATUS = /status\s+([a-z0-9.-]+)/;
const NS_COUNT = /\bns\s+(\d+)\s+found/;

/** `api.acme.co` -> `acme.co` - the zone the illustrative hostnames live under. */
function registrable(target: string): string {
  const labels = target.split(".");
  return labels.slice(1).join(".") || target;
}

export function buildDemoReport(sample: ScanSample): DemoReport {
  const lines = sample.output.map(splitLine);
  const says = (id: string): string | null => lines.find((l) => l.source === id)?.says ?? null;
  const whois = says("whois");
  const ns = whois ? NS_COUNT.exec(whois) : null;
  const nameserverCount = ns ? Number(ns[1]) : null;
  const zone = registrable(sample.target);
  return {
    target: sample.target,
    command: sample.command,
    output: [...sample.output],
    lines,
    metrics: sampleMetrics(sample),
    riskStatus: matchWord(says("risk"), RISK_STATUS),
    registrar: matchWord(whois, REGISTRAR),
    issuer: matchWord(says("crt.sh"), ISSUER),
    nameserverCount,
    names: ILLUSTRATIVE_NAMES[sample.target] ?? [],
    nameServers:
      nameserverCount == null
        ? []
        : Array.from({ length: nameserverCount }, (_, i) => `ns${i + 1}.${zone}`),
    errors: SCRIPTED_ERRORS[sample.target] ?? [],
  };
}

/**
 * Every report, in the order the shared samples declare their targets. The
 * landing terminal, the playground and this page therefore cannot disagree
 * about which targets exist or what they say.
 */
export const DEMO_REPORTS: readonly DemoReport[] = DEMO_SCANS.map(buildDemoReport);

export interface DemoStat {
  key: string;
  label: string;
  value: string;
  hint: string;
}

/** `-` for "the fixture does not record this", never a zero. */
function countValue(n: number | null): string {
  return n == null ? "-" : String(n);
}

/**
 * The instrument strip. Every value is either a count parsed out of the
 * fixture's own lines or the scripted failure count - there is no number in
 * this function that was not already in the data.
 */
export function demoStats(report: DemoReport): DemoStat[] {
  const missing = "the fixture line no longer reports a count";
  return [
    {
      key: "ports",
      label: TERM.ports.label,
      value: countValue(report.metrics.ports),
      hint: report.metrics.ports == null ? missing : "counted in the fixture's shodan line",
    },
    {
      key: "subdomains",
      label: TERM.subdomains.label,
      value: countValue(report.metrics.certNames),
      hint: report.metrics.certNames == null ? missing : "counted in the fixture's crt.sh line",
    },
    {
      key: "nameservers",
      label: TERM.nameservers.label,
      value: countValue(report.nameserverCount),
      hint:
        report.nameserverCount == null
          ? "the fixture's whois line records none"
          : "counted in the fixture's whois line",
    },
    {
      key: "failed",
      label: "Sources that failed",
      value: String(report.errors.length),
      hint:
        report.errors.length > 0
          ? "scripted failure, simulated for this demo"
          : "no failure scripted for this target",
    },
  ];
}

/**
 * The honest sentence under the illustrative names list: how many are shown,
 * how many the fixture counts, and where the demo stops. A list that silently
 * showed 4 of 12 would read as "this target has four names".
 */
export function nameListNote(report: DemoReport): string {
  if (report.names.length === 0) {
    return "No names in the demo fixture for this target.";
  }
  const total = report.metrics.certNames;
  if (total == null) {
    return "The fixture counts no names for this target - the list above is illustrative demo data.";
  }
  const hidden = total - report.names.length;
  if (hidden <= 0) {
    return `Every name the fixture counts (${total}) is listed. The names themselves are illustrative demo data.`;
  }
  return `${report.names.length} of the ${total} names counted in the fixture line are shown. The rest are not invented here - illustrative demo data stops where the count would start lying.`;
}
