/**
 * Client-side export builders for a scan result.
 *
 * Everything a signed-in analyst was shown on the dashboard can be downloaded
 * as JSON, Markdown or PDF. The file is built in the browser from the scan
 * object the page already holds: no request is made, nothing is stored, and no
 * field is added that the dashboard did not already display. (For that reason
 * the Shodan host-enrichment block, which no card renders, is deliberately not
 * exported either.)
 *
 * Four rules hold for every format, and each one is pinned by
 * lib/export-findings.test.ts:
 *
 *  1. External text is PLAIN TEXT. Control and formatting characters are
 *     stripped (a banner carrying ANSI escapes or NUL padding must not corrupt
 *     the file it lands in), banners are cut at BANNER_MAX_CHARS, lists at
 *     LIST_MAX_ITEMS, and every cut says that it happened.
 *  2. Markdown escapes. Short values have every markdown punctuation character
 *     backslash-escaped; multi-line values go into a fenced block whose fence
 *     is longer than any backtick run in the content, so a banner containing
 *     ``` closes nothing and injects nothing.
 *  3. PII is minimized. The export is derived from what the user just saw — no
 *     scan identifier, no extra fields, no second copy anywhere.
 *  4. The caveats travel with the data. "No match" is not proof of safety,
 *     missing data is unknown rather than zero, and every source in `errors[]`
 *     is listed with its message instead of being dropped.
 *
 * This module has no dependency on any PDF library: `buildPdfLines` produces
 * plain lines and lib/export-pdf.ts draws them.
 */

import type { ScanResult } from "./api.ts";
import { getCveEvidence } from "./scan-shape.ts";
import { nvdStatusView } from "./scan-status.ts";
import { normalizeSubdomains, subdomainsCountsNote } from "./subdomains-view.ts";
import { asPlainText, parseThreatHistory, SAFETY_CAVEAT, safeHttpsUrl, statusBadge } from "./threat-history-shape.ts";
import { TERM, plural } from "./terms.ts";

/** Banners are attacker-written; the cut is always disclosed. */
export const BANNER_MAX_CHARS = 2048;
/** Every list in the export is capped, and the cap states what it hid. */
export const LIST_MAX_ITEMS = 500;
/** A provider error message is external text too. */
export const ERROR_MAX_CHARS = 500;

/**
 * Control characters (kept: tab and newline, which banners legitimately carry),
 * plus the zero-width and bidi-override characters used to smuggle invisible
 * text through a viewer.
 */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

export interface PlainText {
  text: string;
  /** True when the value was cut to fit the cap; the cut is always disclosed. */
  truncated: boolean;
}

function stripControls(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\r\n?/g, "\n").replace(CONTROL_CHARS, " ").trim();
}

/** Single-line plain text: control characters gone, whitespace collapsed. */
function oneLine(value: unknown, max?: number): PlainText {
  const text = asPlainText(stripControls(value));
  return clip(text, max);
}

/** Bounded plain text with the cut flagged. */
function clip(text: string, max?: number): PlainText {
  if (max == null || text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

/** Multi-line plain text (banners keep their line breaks), cut at `max`. */
function blockText(value: unknown, max: number = BANNER_MAX_CHARS): PlainText {
  return clip(stripControls(value), max);
}

function dash(text: string): string {
  return text.length > 0 ? text : "—";
}

function numberOrDash(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "—";
}

/* ------------------------------------------------------------------ *
 * The report: one normalized structure all three formats render from
 * ------------------------------------------------------------------ */

export interface ExportServiceRow {
  port: string;
  product: string;
  version: string;
  banner: PlainText;
}

export interface ExportCveRow {
  id: string;
  confidence: string;
  confidenceDetail: string;
  severity: string;
  cvss: string;
  product: string;
  source: string;
  url: string | null;
}

export interface ExportSubdomainRow {
  subdomain: string;
  issuer: string | null;
  not_before: string | null;
  not_after: string | null;
  /** "active" | "expired" | "unknown" */
  validity: string;
  merged: number;
}

export interface ExportSourceError {
  source: string;
  message: PlainText;
}

export interface ExportReport {
  title: string;
  target: string;
  status: { label: string; detail: string };
  generatedAt: string;
  riskScore: number | null;
  provenance: string[];
  caveats: string[];
  sourceErrors: ExportSourceError[];
  everySourceAnswered: boolean;
  ports: {
    summary: string;
    services: ExportServiceRow[];
    hidden: number;
  } | null;
  vulnerabilities: {
    statusLabel: string;
    statusDetail: string;
    rows: ExportCveRow[];
    hidden: number;
    notes: string[];
  } | null;
  subdomains: {
    reported: number;
    unique: number;
    duplicatesMerged: number;
    active: number;
    expired: number;
    unknown: number;
    rows: ExportSubdomainRow[];
    hidden: number;
    notes: string[];
  } | null;
  whois: {
    rows: Array<{ label: string; value: string }>;
    notes: string[];
  } | null;
  history: {
    headline: string;
    detail: string;
    notes: string[];
    sources: Array<{
      label: string;
      outcome: string;
      count: number;
      message: string;
      note: string;
      truncationNote: string;
      rows: Array<{ cells: string[] }>;
      hidden: number;
    }>;
  } | null;
}

/** Shown on the export card so the button and the file promise the same thing. */
export const EXPORT_CAVEAT_SUMMARY =
  "Every file carries the same caveats as this screen: no match is not proof of safety, missing data is unknown rather than zero, and the sources that failed are listed.";

const PROVENANCE = [
  "Generated in your browser from the scan you were reading on the dashboard. Nothing was uploaded, and no copy was stored by us.",
  "This file carries only what that screen showed you — nothing was added and nothing was checked again.",
];

const BASE_CAVEATS = [
  "A result with no matches is not proof the target is safe.",
  "Missing data means unknown, not zero.",
];

function capList<T>(items: T[]): { items: T[]; hidden: number } {
  if (items.length <= LIST_MAX_ITEMS) return { items, hidden: 0 };
  return { items: items.slice(0, LIST_MAX_ITEMS), hidden: items.length - LIST_MAX_ITEMS };
}

/** Build the normalized, truncated report every format renders from. */
export function buildExportReport(scan: ScanResult | null | undefined, now: Date = new Date()): ExportReport {
  const empty: ExportReport = {
    title: "Findings export — no scan",
    target: "",
    status: { label: "Unknown", detail: "" },
    generatedAt: now.toISOString(),
    riskScore: null,
    provenance: PROVENANCE,
    caveats: BASE_CAVEATS,
    sourceErrors: [],
    everySourceAnswered: true,
    ports: null,
    vulnerabilities: null,
    subdomains: null,
    whois: null,
    history: null,
  };
  if (!scan) return empty;

  const status = scanStatusLabelAndDetail(scan.status);
  const target = oneLine(scan.target, 253).text;
  const caveats = [...BASE_CAVEATS];

  // errors[] — a source that failed is stated, never dropped.
  const sourceErrors: ExportSourceError[] = (Array.isArray(scan.errors) ? scan.errors : [])
    .filter((e) => e && typeof e === "object")
    .map((e) => ({
      source: oneLine(e.source, 64).text || "unknown source",
      message: oneLine(e.message, ERROR_MAX_CHARS),
    }));
  if (sourceErrors.length > 0) {
    caveats.push(
      `${sourceErrors.length} ${plural(sourceErrors.length, "source", "sources")} did not answer, so this report is incomplete. Anything missing from it was not checked, not confirmed absent.`,
    );
  }

  // Risk score — the same caveat the dashboard's glossary carries.
  if (typeof scan.risk_score === "number") caveats.push(`${TERM.risk.label}: ${TERM.risk.note}`);

  // Ports & services.
  const shodan = scan.results.shodan;
  const services = Array.isArray(shodan?.services) ? shodan.services : [];
  const cappedServices = capList(services);
  const serviceRows: ExportServiceRow[] = cappedServices.items.map((s) => ({
    port: numberOrDash(s?.port),
    product: oneLine(s?.product, 200).text || "—",
    version: oneLine(s?.version, 100).text || "—",
    banner: blockText(s?.banner, BANNER_MAX_CHARS),
  }));
  const portSummary = shodan
    ? `${services.length} ${plural(services.length, "service", "services")} found${shodan.ip ? ` on ${oneLine(shodan.ip, 64).text}` : ""}, read from Shodan's public index of internet-wide scans. Nothing was probed on the target.`
    : "No host was resolved, so there are no services to report. That is unknown, not none.";

  // Known vulnerabilities. The two backend shapes (`cve_rows`, legacy `cves`)
  // are normalized into one row shape here rather than at every use site.
  const nvd = scan.results.nvd;
  const evidence = getCveEvidence(scan.results);
  const nvdView = nvdStatusView(nvd?.status);
  interface CveLike {
    id?: string;
    tier?: string;
    severity?: string | null;
    cvss?: number | null;
    evidence_cpe?: string | null;
    source?: string;
    url?: string;
  }
  const cveSource: CveLike[] =
    Array.isArray(nvd?.cve_rows) && nvd.cve_rows.length > 0
      ? nvd.cve_rows
      : Array.isArray(nvd?.cves)
        ? nvd.cves.map((c): CveLike => ({ id: c.id, tier: "unverified", severity: c.severity, cvss: c.cvss, evidence_cpe: c.evidence_cpe, source: "NVD" }))
        : [];
  const cappedCves = capList(cveSource);
  const cveNotes: string[] = [];
  if (cappedCves.hidden > 0) {
    cveNotes.push(
      `Only the first ${LIST_MAX_ITEMS.toLocaleString("en-US")} of ${cveSource.length.toLocaleString("en-US")} entries are listed — ${cappedCves.hidden.toLocaleString("en-US")} more ${plural(cappedCves.hidden, "entry", "entries")} ${plural(cappedCves.hidden, "is", "are")} not in this file.`,
    );
  }
  if (nvd?.truncated) cveNotes.push("The vulnerability database reported a truncated result set, so more entries exist than it returned.");
  if (!nvd) {
    cveNotes.push("This target was not checked against the vulnerability catalogue. Coverage is unknown, not zero.");
  } else if (evidence.status === "no_match") {
    cveNotes.push(nvdView.detail);
  } else if (evidence.status === "keyword_derived") {
    cveNotes.push(nvdView.detail);
    cveNotes.push("These rows are leads, not findings: none of them count toward the risk score.");
  } else if (evidence.status === "source_only") {
    cveNotes.push(nvdView.detail);
  } else if (evidence.status === "none") {
    cveNotes.push(nvdView.detail);
  }

  // Subdomains — the same cleansed view the table renders.
  const subdomains = normalizeSubdomains(scan.results);
  const cappedSubdomains = capList(subdomains.rows);
  const subNotes = [subdomainsCountsNote(subdomains)].filter(Boolean);
  if (cappedSubdomains.hidden > 0) {
    subNotes.push(
      `Only the first ${LIST_MAX_ITEMS.toLocaleString("en-US")} of ${subdomains.unique.toLocaleString("en-US")} names are listed — ${cappedSubdomains.hidden.toLocaleString("en-US")} more ${plural(cappedSubdomains.hidden, "name", "names")} ${plural(cappedSubdomains.hidden, "is", "are")} not in this file.`,
    );
  }

  // WHOIS.
  const w = scan.results.whois;
  const whoisRows = w
    ? [
        { label: TERM.registrant.label, value: dash(oneLine(w.registrar, 200).text) },
        { label: "First registered", value: dash(oneLine(w.creation_date, 64).text) },
        { label: "Expires", value: dash(oneLine(w.expiration_date, 64).text) },
        ...nameserverRows(w.name_servers),
        { label: "Contact addresses", value: dash(oneLine(w.emails, 500).text) },
      ]
    : [];

  // Threat & incident history, when the orchestrator ran that fallback.
  const history = parseThreatHistory(scan.results.history);

  return {
    title: `Findings export — ${target || "unknown target"}`,
    target,
    status,
    generatedAt: now.toISOString(),
    riskScore: typeof scan.risk_score === "number" ? scan.risk_score : null,
    provenance: PROVENANCE,
    caveats,
    sourceErrors,
    everySourceAnswered: sourceErrors.length === 0,
    ports: {
      summary: portSummary,
      services: serviceRows,
      hidden: cappedServices.hidden,
    },
    vulnerabilities: nvd
      ? {
          statusLabel: nvdView.label,
          statusDetail: nvdView.detail,
          rows: cappedCves.items.map((c) => ({
            id: oneLine(c?.id, 64).text || "—",
            confidence: tierLabel(c?.tier),
            confidenceDetail: tierDetail(c?.tier),
            severity: oneLine(c?.severity, 40).text || "—",
            cvss: typeof c?.cvss === "number" && Number.isFinite(c.cvss) ? `${c.cvss}/10` : "—",
            product: oneLine(c?.evidence_cpe, 300).text || "—",
            source: oneLine(c?.source, 100).text || "—",
            url: cveUrl(c?.id, c?.url),
          })),
          hidden: cappedCves.hidden,
          notes: cveNotes,
        }
      : null,
    subdomains:
      subdomains.unique > 0
        ? {
            reported: subdomains.reported,
            unique: subdomains.unique,
            duplicatesMerged: subdomains.duplicatesMerged,
            active: subdomains.active,
            expired: subdomains.expired,
            unknown: subdomains.unknown,
            rows: cappedSubdomains.items.map((r) => ({
              subdomain: r.subdomain,
              issuer: r.issuer,
              not_before: r.not_before,
              not_after: r.not_after,
              validity: r.validity,
              merged: r.merged,
            })),
            hidden: cappedSubdomains.hidden,
            notes: subNotes,
          }
        : {
            reported: subdomains.reported,
            unique: 0,
            duplicatesMerged: 0,
            active: 0,
            expired: 0,
            unknown: 0,
            rows: [],
            hidden: 0,
            notes: ["No names were returned by the certificate log. That is not the same as there being none."],
          },
    whois: w
      ? {
          rows: whoisRows,
          notes: [
            "The registry publishes some fields and withholds others, so an empty field is a withheld value, not an absent one.",
          ],
        }
      : null,
    history: history
      ? {
          headline: history.headline,
          detail: history.detail,
          notes: [history.note, SAFETY_CAVEAT].filter((s) => s.length > 0),
          sources: history.sources.map((s) => {
            const capped = capList(s.rows);
            return {
              label: s.label,
              outcome: statusBadge(s.outcome).text,
              count: typeof s.count === "number" ? s.count : capped.items.length,
              message: s.message,
              note: s.note,
              truncationNote: s.truncationNote,
              rows: capped.items.map((r) => ({ cells: r.cells.map((c) => `${c.label}: ${c.value}`) })),
              hidden: capped.hidden,
            };
          }),
        }
      : null,
  };
}

function nameserverRows(value: unknown): Array<{ label: string; value: string }> {
  const items = Array.isArray(value) ? value : [];
  const capped = capList(items);
  const rows = capped.items.map((ns) => ({ label: TERM.nameservers.label, value: oneLine(ns, 253).text || "—" }));
  if (capped.hidden > 0) {
    rows.push({
      label: TERM.nameservers.label,
      value: `${capped.hidden.toLocaleString("en-US")} more ${plural(capped.hidden, "nameserver", "nameservers")} are not listed — the list was cut at ${LIST_MAX_ITEMS}.`,
    });
  }
  if (rows.length === 0) rows.push({ label: TERM.nameservers.label, value: "Not published" });
  return rows;
}

function tierLabel(tier: unknown): string {
  const text = asPlainText(tier);
  if (text === "verified") return "Confirmed match";
  if (text === "rejected") return "Rejected by the publisher";
  return "Reported, unconfirmed";
}

function tierDetail(tier: unknown): string {
  const text = asPlainText(tier);
  if (text === "verified") return "Matches the exact product and version running on this host.";
  if (text === "rejected") return "The catalogue vendor marked this entry as rejected or disputed. Shown for completeness — never counted.";
  return "A public index reported this vulnerability for this host, but it could not be confirmed against the exact product and version.";
}

/** Only https URLs survive, and the NVD detail page is the fallback. */
function cveUrl(id: unknown, url: unknown): string | null {
  const vetted = safeHttpsUrl(url);
  if (vetted) return vetted;
  const clean = asPlainText(id);
  return /^CVE-\d{4}-\d{4,}$/.test(clean) ? `https://nvd.nist.gov/vuln/detail/${clean}` : null;
}

function scanStatusLabelAndDetail(status: ScanResult["status"] | string): { label: string; detail: string } {
  // Kept local so this module does not widen its imports for one call; the
  // wording is the dashboard's own status copy.
  const views: Record<string, { label: string; detail: string }> = {
    pending: { label: "Queued", detail: "The scan was queued when this result was produced." },
    running: { label: "Searching", detail: "The scan was still running when this result was produced, so it is incomplete." },
    completed: { label: "Complete", detail: "Every source answered." },
    partial: {
      label: "Partly answered",
      detail:
        "At least one source failed, so this result is incomplete. Missing items were not checked — treat them as unknown, not as absent.",
    },
    failed: { label: "Failed", detail: "No source returned a result for this target." },
  };
  const view = typeof status === "string" ? views[status] : undefined;
  return (
    view ?? {
      label: "Unknown",
      detail: "This result carries a status the dashboard does not recognise. Treat it as unknown, not as clean.",
    }
  );
}

/* ------------------------------------------------------------------ *
 * JSON
 * ------------------------------------------------------------------ */

/** The report as pretty-printed JSON. Strings are already plain text. */
export function buildJsonExport(scan: ScanResult | null | undefined, now: Date = new Date()): string {
  const report = buildExportReport(scan, now);
  return `${JSON.stringify(report, null, 2)}\n`;
}

/* ------------------------------------------------------------------ *
 * Markdown
 * ------------------------------------------------------------------ */

/**
 * Every ASCII punctuation character a markdown parser can treat as structure.
 * Backslash-escaping any of them renders the literal character, which is what
 * an externally supplied string must do.
 */
const MARKDOWN_PUNCTUATION = /[\\`*_{}[\]()#+\-.!|<>~]/g;

export function escapeMarkdown(text: string): string {
  return text.replace(MARKDOWN_PUNCTUATION, "\\$&");
}

/**
 * A fenced code block whose fence is longer than any backtick run in the
 * content. A banner containing ``` therefore closes nothing: the standard
 * defence against hostile content in a fenced block, because there is no
 * escape character inside one.
 */
export function fenceBlock(text: string): string {
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}\n${text}\n${ticks}`;
}

/** "text (cut short at N characters)" — the disclosure that follows a cut. */
function cutNote(max: number): string {
  return `(cut short at ${max.toLocaleString("en-US")} characters)`;
}

export function buildMarkdownExport(scan: ScanResult | null | undefined, now: Date = new Date()): string {
  const r = buildExportReport(scan, now);
  const lines: string[] = [];

  lines.push(`# ${escapeMarkdown(r.title)}`, "");
  lines.push(`- **Target:** \`${escapeMarkdown(r.target)}\``);
  lines.push(`- **Status:** ${escapeMarkdown(r.status.label)} — ${escapeMarkdown(r.status.detail)}`);
  lines.push(`- **Generated:** ${escapeMarkdown(r.generatedAt)}`);
  lines.push(`- **${escapeMarkdown(TERM.risk.label)}:** ${r.riskScore == null ? "not computed" : `${r.riskScore}/100`}`);
  lines.push("");

  for (const p of r.provenance) lines.push(`> ${escapeMarkdown(p)}`);
  lines.push("");

  lines.push("## Read this first", "");
  for (const c of r.caveats) lines.push(`- ${escapeMarkdown(c)}`);
  lines.push("");

  lines.push("## Sources that did not answer", "");
  if (r.sourceErrors.length === 0) {
    lines.push("- Every source answered, so nothing is missing from this report.");
  } else {
    for (const e of r.sourceErrors) {
      lines.push(`- \`${escapeMarkdown(e.source)}\` — ${escapeMarkdown(e.message.text)}`);
      if (e.message.truncated) lines.push(`  ${escapeMarkdown(cutNote(ERROR_MAX_CHARS))}`);
    }
  }
  lines.push("");

  lines.push(`## ${TERM.ports.label} & ${TERM.services.label.toLowerCase()}`, "");
  if (!r.ports) {
    lines.push("_No host was resolved for this target, so no services were reported._", "");
  } else {
    lines.push(escapeMarkdown(r.ports.summary), "");
    for (const s of r.ports.services) {
      const name = [s.product, s.version].filter((v) => v !== "—").join(" ");
      lines.push(`- Port ${escapeMarkdown(s.port)}${name ? ` — ${escapeMarkdown(name)}` : ""}`);
      if (s.banner.text) {
        lines.push("");
        lines.push(escapeMarkdown(`${TERM.banner.label}${s.banner.truncated ? ` ${cutNote(BANNER_MAX_CHARS)}` : ""}:`));
        lines.push("");
        lines.push(fenceBlock(s.banner.text));
        lines.push("");
      }
    }
    if (r.ports.hidden > 0) {
      lines.push(
        `Only the first ${LIST_MAX_ITEMS.toLocaleString("en-US")} services are listed — ${r.ports.hidden.toLocaleString("en-US")} more ${plural(r.ports.hidden, "service", "services")} ${plural(r.ports.hidden, "is", "are")} not in this file.`,
        "",
      );
    }
  }

  lines.push(`## ${TERM.cves.label}`, "");
  if (!r.vulnerabilities) {
    lines.push("_This target was not checked against the vulnerability catalogue. That is unknown, not none._", "");
  } else {
    lines.push(`**${escapeMarkdown(r.vulnerabilities.statusLabel)}** — ${escapeMarkdown(r.vulnerabilities.statusDetail)}`, "");
    if (r.vulnerabilities.rows.length === 0) {
      lines.push("_No entries matched the product and version detected here. Coverage beyond this check is still unknown._", "");
    } else {
      for (const c of r.vulnerabilities.rows) {
        const link = c.url ? `[${escapeMarkdown(c.id)}](<${c.url}>)` : `\`${escapeMarkdown(c.id)}\``;
        lines.push(`- ${link} — ${escapeMarkdown(c.confidence)}; ${escapeMarkdown(c.severity)}; ${escapeMarkdown(c.cvss)}; product: \`${escapeMarkdown(c.product)}\`; source: ${escapeMarkdown(c.source)}`);
        lines.push(`  ${escapeMarkdown(c.confidenceDetail)}`);
      }
    }
    for (const n of r.vulnerabilities.notes) lines.push(`- ${escapeMarkdown(n)}`);
    lines.push("");
  }

  lines.push(`## ${TERM.subdomains.label}`, "");
  if (!r.subdomains || r.subdomains.unique === 0) {
    lines.push("_No names were returned by the certificate log. That is not the same as there being none._", "");
  } else {
    const s = r.subdomains;
    lines.push(
      `${s.reported.toLocaleString("en-US")} ${plural(s.reported, "entry", "entries")} from the log reduced to ${s.unique.toLocaleString("en-US")} ${plural(s.unique, "name", "names")}: ${s.active.toLocaleString("en-US")} active, ${s.expired.toLocaleString("en-US")} expired, ${s.unknown.toLocaleString("en-US")} with dates that could not be read.`,
      "",
    );
    for (const row of s.rows) {
      const parts = [`${escapeMarkdown(row.issuer ?? "issuer unknown")}`, `valid until ${escapeMarkdown(row.not_after ?? "unknown")}`, subdomainValidityWord(row.validity)];
      if (row.merged > 1) parts.push(`${row.merged} log entries merged`);
      lines.push(`- \`${escapeMarkdown(row.subdomain)}\` — ${parts.join("; ")}`);
    }
    for (const n of s.notes) lines.push("", escapeMarkdown(n));
    lines.push("");
  }

  lines.push(`## ${TERM.whois.label}`, "");
  if (!r.whois) {
    lines.push("_No registration record was returned for this target. That is not the same as there being one._", "");
  } else {
    for (const row of r.whois.rows) lines.push(`- **${escapeMarkdown(row.label)}:** ${escapeMarkdown(row.value)}`);
    for (const n of r.whois.notes) lines.push("", escapeMarkdown(n));
    lines.push("");
  }

  lines.push("## Threat & incident history", "");
  if (!r.history) {
    lines.push("_No history sources ran for this scan, so there is nothing to report here._", "");
  } else {
    lines.push(`**${escapeMarkdown(r.history.headline)}** — ${escapeMarkdown(r.history.detail)}`, "");
    for (const s of r.history.sources) {
      lines.push(`- ${escapeMarkdown(s.label)} — ${escapeMarkdown(s.outcome)}; ${s.count.toLocaleString("en-US")} ${plural(s.count, "record", "records")}`);
      if (s.message) lines.push(`  ${escapeMarkdown(s.message)}`);
      if (s.note) lines.push(`  ${escapeMarkdown(s.note)}`);
      if (s.truncationNote) lines.push(`  ${escapeMarkdown(s.truncationNote)}`);
      for (const row of s.rows) lines.push(`  - ${escapeMarkdown(row.cells.join(" — "))}`);
      if (s.hidden > 0) {
        lines.push(`  ${s.hidden.toLocaleString("en-US")} more ${plural(s.hidden, "record", "records")} ${plural(s.hidden, "is", "are")} not listed — the list was cut at ${LIST_MAX_ITEMS}.`);
      }
    }
    for (const n of r.history.notes) lines.push("", escapeMarkdown(n));
    lines.push("");
  }

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

function subdomainValidityWord(validity: string): string {
  if (validity === "active") return "active";
  if (validity === "expired") return "expired";
  return "validity unknown";
}

/* ------------------------------------------------------------------ *
 * PDF
 * ------------------------------------------------------------------ */

/**
 * The report as flat text lines, ready to be drawn.
 *
 * Deliberately not a PDF itself: the drawing lives in lib/export-pdf.ts so this
 * module stays dependency-free and testable, and the only place `jspdf` enters
 * the bundle is a dynamically imported chunk that loads when the user asks for
 * a PDF.
 */
export function buildPdfLines(scan: ScanResult | null | undefined, now: Date = new Date()): string[] {
  const r = buildExportReport(scan, now);
  const lines: string[] = [];

  lines.push(r.title, "");
  lines.push(`Target: ${r.target || "unknown target"}`);
  lines.push(`Status: ${r.status.label} — ${r.status.detail}`);
  lines.push(`Generated: ${r.generatedAt}`);
  lines.push(`${TERM.risk.label}: ${r.riskScore == null ? "not computed" : `${r.riskScore}/100`}`, "");

  for (const p of r.provenance) lines.push(p);
  lines.push("");

  lines.push("READ THIS FIRST");
  for (const c of r.caveats) lines.push(`- ${c}`);
  lines.push("");

  lines.push("SOURCES THAT DID NOT ANSWER");
  if (r.sourceErrors.length === 0) {
    lines.push("- Every source answered, so nothing is missing from this report.");
  } else {
    for (const e of r.sourceErrors) {
      lines.push(`- ${e.source}: ${e.message.text}${e.message.truncated ? ` (cut short at ${ERROR_MAX_CHARS} characters)` : ""}`);
    }
  }
  lines.push("");

  lines.push("OPEN PORTS & SERVICES");
  if (!r.ports) {
    lines.push("No host was resolved for this target, so no services were reported.");
  } else {
    lines.push(r.ports.summary, "");
    for (const s of r.ports.services) {
      const name = [s.product, s.version].filter((v) => v !== "—").join(" ");
      lines.push(`- Port ${s.port}${name ? ` — ${name}` : ""}`);
      if (s.banner.text) {
        for (const l of s.banner.text.split("\n")) lines.push(`    ${l}`);
        if (s.banner.truncated) lines.push(`    (cut short at ${BANNER_MAX_CHARS} characters)`);
      }
    }
    if (r.ports.hidden > 0) {
      lines.push(`Only the first ${LIST_MAX_ITEMS} services are listed — ${r.ports.hidden} more ${plural(r.ports.hidden, "service", "services")} ${plural(r.ports.hidden, "is", "are")} not in this file.`);
    }
  }
  lines.push("");

  lines.push("KNOWN VULNERABILITIES");
  if (!r.vulnerabilities) {
    lines.push("This target was not checked against the vulnerability catalogue. That is unknown, not none.");
  } else {
    lines.push(`${r.vulnerabilities.statusLabel} — ${r.vulnerabilities.statusDetail}`, "");
    for (const c of r.vulnerabilities.rows) {
      lines.push(`- ${c.id} — ${c.confidence}; ${c.severity}; ${c.cvss}; product: ${c.product}; source: ${c.source}`);
      if (c.url) lines.push(`  ${c.url}`);
      lines.push(`  ${c.confidenceDetail}`);
    }
    if (r.vulnerabilities.rows.length === 0) {
      lines.push("No entries matched the product and version detected here. Coverage beyond this check is still unknown.");
    }
    for (const n of r.vulnerabilities.notes) lines.push(`- ${n}`);
  }
  lines.push("");

  lines.push("SUBDOMAINS");
  if (!r.subdomains || r.subdomains.unique === 0) {
    lines.push("No names were returned by the certificate log. That is not the same as there being none.");
  } else {
    const s = r.subdomains;
    lines.push(
      `${s.reported} entries from the log reduced to ${s.unique} names: ${s.active} active, ${s.expired} expired, ${s.unknown} with dates that could not be read.`,
      "",
    );
    for (const row of s.rows) {
      lines.push(
        `- ${row.subdomain} — ${row.issuer ?? "issuer unknown"}; valid until ${row.not_after ?? "unknown"}; ${subdomainValidityWord(row.validity)}${row.merged > 1 ? `; ${row.merged} log entries merged` : ""}`,
      );
    }
    for (const n of s.notes) lines.push("", n);
  }
  lines.push("");

  lines.push("DOMAIN DETAILS (WHOIS)");
  if (!r.whois) {
    lines.push("No registration record was returned for this target. That is not the same as there being one.");
  } else {
    for (const row of r.whois.rows) lines.push(`- ${row.label}: ${row.value}`);
    for (const n of r.whois.notes) lines.push("", n);
  }
  lines.push("");

  lines.push("THREAT & INCIDENT HISTORY");
  if (!r.history) {
    lines.push("No history sources ran for this scan, so there is nothing to report here.");
  } else {
    lines.push(`${r.history.headline} — ${r.history.detail}`, "");
    for (const s of r.history.sources) {
      lines.push(`- ${s.label} — ${s.outcome}; ${s.count} records`);
      if (s.message) lines.push(`  ${s.message}`);
      if (s.note) lines.push(`  ${s.note}`);
      if (s.truncationNote) lines.push(`  ${s.truncationNote}`);
      for (const row of s.rows) lines.push(`  - ${row.cells.join(" — ")}`);
      if (s.hidden > 0) lines.push(`  ${s.hidden} more ${plural(s.hidden, "record", "records")} ${plural(s.hidden, "is", "are")} not listed — the list was cut at ${LIST_MAX_ITEMS}.`);
    }
    for (const n of r.history.notes) lines.push("", n);
  }

  return lines;
}

/* ------------------------------------------------------------------ *
 * File names
 * ------------------------------------------------------------------ */

/** Safe file stem: no separators, no dots, bounded length. */
export function exportFileStem(target: string, now: Date = new Date()): string {
  const slug = target
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const stamp = now.toISOString().replace(/[:.]/g, "-").replace(/z$/i, "");
  return `nusa-${slug || "target"}-${stamp}`;
}
export const EXPORT_MIME = {
  json: "application/json",
  markdown: "text/markdown",
  pdf: "application/pdf",
} as const;

export type ExportFormat = keyof typeof EXPORT_MIME;

export function exportFileName(format: ExportFormat, target: string, now: Date = new Date()): string {
  const ext = format === "json" ? "json" : format === "markdown" ? "md" : "pdf";
  return `${exportFileStem(target, now)}.${ext}`;
}
