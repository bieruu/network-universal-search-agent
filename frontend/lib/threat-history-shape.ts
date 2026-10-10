// Types + pure helpers for the `results.history` block the orchestrator adds
// when official CVE data came back empty (see orchestrator._threat_history_fallback).
//
// Two rules this module exists to enforce, mirroring scan-shape.ts:
//
//   1. The payload is untrusted and optional. `parseThreatHistory` narrows an
//      `unknown` into a `ThreatHistory | null` and never throws, so the card can
//      render nothing for a missing/malformed block instead of crashing.
//   2. Every attacker-influenced string (breach names, community pulse names
//      and descriptions, upstream notes) is reduced to PLAIN TEXT here — control characters
//      stripped, never markup. The card renders these values as text children,
//      so React escapes them; no helper may return a field the caller is
//      tempted to inject as HTML.
//
// An empty history block is the NORMAL, healthy outcome, so the aggregate
// summary distinguishes "no records found" from "we could not check" and never
// presents the first as the second.

/** Server-side caps stay authoritative; this is the display cap. */
export const MAX_ROWS_PER_SOURCE = 100;
/** OTX pulse names are capped server-side; show a 120-char preview. */
export const PULSE_PREVIEW_CHARS = 120;
/** Pulse descriptions are community-written and often long; preview harder. */
export const PULSE_DESCRIPTION_CHARS = 220;

export type HistorySourceKey = "otx" | "urlscan" | "leaklookup";

export type HistorySourceStatus = "ok" | "unavailable" | "not_configured";

/**
 * How one source should READ to a user. Kept separate from the wire `status`
 * so an unrecognised status is its own outcome instead of collapsing into
 * "clean": `unknown_status` renders like a failure, because the result is not
 * trustworthy and must not be presented as evidence of safety.
 */
export type SourceOutcome =
  | "findings"
  | "no_records"
  | "not_configured"
  | "unavailable"
  | "unknown_status";

export type HistoryOutcome = "findings" | "no_records" | "incomplete";

/** One table cell. `value` is always plain text; `href` is set only for https URLs we vetted. */
export interface HistoryCell {
  label: string;
  value: string;
  /** Render monospace + ellipsis with the full value in `title`. */
  mono?: boolean;
  /** The value was cut for display, or the server flagged this field as cut. */
  truncated?: boolean;
  /** Pre-vetted https URL. Rendered as a link; null/undefined renders plain text. */
  href?: string | null;
}

export interface HistoryRow {
  id: string;
  cells: HistoryCell[];
}

export interface HistorySourceError {
  source: string;
  message: string;
}

export interface HistorySource {
  key: HistorySourceKey;
  label: string;
  /** The source's own label when it sent one, else our label. */
  source: string;
  status: HistorySourceStatus | "unknown";
  outcome: SourceOutcome;
  /** Count the server reported, or the row count when it sent nothing usable. */
  count: number;
  /** Copy explaining the outcome. Plain text. */
  message: string;
  /** The source's own note, verbatim (plain text). */
  note: string;
  rows: HistoryRow[];
  /** Rows the payload carried before the display cap. */
  available: number;
  /** Explicit note when rows or a field were cut. Empty when nothing was cut. */
  truncationNote: string;
  /** urlscan only; vetted https URL or null. */
  screenshotUrl: string | null;
  /** urlscan only. */
  total: number | null;
  /** urlscan only. */
  windowDays: number | null;
}

export interface HistorySummary {
  outcome: HistoryOutcome;
  headline: string;
  detail: string;
  findingCount: number;
  /** Sources that answered (findings or a clean zero). */
  okSources: number;
  /** Sources that were unreachable or returned an unrecognised status. */
  failedSources: number;
  /** Sources switched off in this deployment. */
  unconfiguredSources: number;
}

export interface ThreatHistory {
  source: string;
  triggerReason: string;
  note: string;
  sources: HistorySource[];
  errors: HistorySourceError[];
  summary: HistorySummary;
  headline: string;
  detail: string;
}

/** Shown on the empty state so a clean result never reads as "safe". */
export const SAFETY_CAVEAT =
  "An empty result only covers what these sources have recorded. It is not evidence the target is safe, and it does not replace the CVE evidence these sources do not cover.";

export const SOURCE_LABELS: Record<HistorySourceKey, string> = {
  otx: "AlienVault OTX pulses",
  urlscan: "URLScan.io history",
  leaklookup: "Leak-Lookup",
};

/**
 * Plain column headings, with the precise term kept for anyone who needs it.
 *
 * The heading text is what every row of that source renders under, so it is
 * defined once here rather than per-builder. Acronyms an analyst greps for
 * (TLP, pulse, verdict) survive in the tooltip instead of the header, where
 * they cost nothing and mean something to the right reader.
 */
export const COLUMN_HEADINGS: Record<string, { label: string; title: string }> = {
  Verdict: { label: "Result", title: "urlscan's overall judgement of the page when it was scanned" },
  "Scanned page": { label: "Scanned page", title: "The page urlscan.io visited and recorded" },
  "Scan UUID": { label: "Scan ID", title: "urlscan's identifier for that scan. Use it to look the scan up on urlscan.io." },
  Pulse: { label: "Threat feed", title: "An AlienVault OTX pulse: a community-curated list of indicators published on a topic." },
  Description: { label: "What the feed says", title: "The publisher's own summary of the pulse" },
  Created: { label: "First published", title: "When the publisher added this feed entry" },
  TLP: { label: "Sharing restriction", title: "How widely the publisher says this record may be shared (TLP)" },
  Author: { label: "Published by", title: "Who published the pulse" },
  Malware: { label: "Malware families", title: "Malware names the feed associates with this indicator" },
  Adversary: { label: "Threat actor", title: "Who OTX attributes the activity to, where it names one" },
  Breach: { label: "Breach", title: "The named data breach an account address appeared in" },
  "Breach date": { label: "Breach date", title: "When the breach itself happened" },
  Records: { label: "Accounts exposed", title: "How many accounts from that breach share this address" },
};

/** Heading text + tooltip for one column id, falling back to the raw id. */
export function columnHeading(id: string): { label: string; title: string } {
  return COLUMN_HEADINGS[id] ?? { label: id, title: "" };
}

const SOURCE_KEYS: HistorySourceKey[] = ["otx", "urlscan", "leaklookup"];

// C0 controls (NUL, ESC, …) plus DEL. Defacement banners and breach names are
// attacker-influenced and can carry ANSI escapes or NUL padding; a text node
// renders them harmlessly but they corrupt layout when printed.
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reduce any untrusted value to display-safe PLAIN TEXT. Never returns markup
 * it did not receive, and never a non-string: non-strings become "".
 */
export function asPlainText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
}

/** Plain text clipped to `max` characters, with an explicit truncation flag. */
export function clipText(value: unknown, max: number): { text: string; truncated: boolean } {
  const text = asPlainText(value);
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max)}…`, truncated: true };
}

/** Join an unknown array of strings, capped, flagging the cut instead of hiding it. */
export function formatList(value: unknown, maxItems = 8): { text: string; truncated: boolean } {
  if (!Array.isArray(value)) return { text: "", truncated: false };
  const items = value.map(asPlainText).filter((s) => s.length > 0);
  if (items.length === 0) return { text: "", truncated: false };
  if (items.length <= maxItems) return { text: items.join(", "), truncated: false };
  return { text: `${items.slice(0, maxItems).join(", ")} +${items.length - maxItems} more`, truncated: true };
}

/** Thousands-separated integer, or an em dash when the source sent nothing usable. */
export function formatCount(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US");
}

export function formatBool(value: unknown): string {
  if (value === true) return "yes";
  if (value === false) return "no";
  return "—";
}

/**
 * Only https URLs survive. Defacement records and urlscan pages are
 * attacker-influenced, so a `javascript:` or `data:` href must never reach an
 * anchor. Written as a scheme allowlist rather than a blocklist so an unlisted
 * scheme (`vbscript:`, `blob:`) cannot slip through.
 */
export function safeHttpsUrl(value: unknown): string | null {
  const text = asPlainText(value);
  if (!/^https:\/\//i.test(text)) return null;
  try {
    return new URL(text).toString();
  } catch {
    return null;
  }
}

/** Rows from the payload, objects only. Junk entries are dropped, not rendered. */
function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

/** Apply the display cap and say so. A silent cut is a lie about coverage. */
export function limitRows<T>(rows: T[], truncatedBySource: boolean, label: string): { rows: T[]; note: string; available: number } {
  const available = rows.length;
  if (available <= MAX_ROWS_PER_SOURCE) {
    const note = truncatedBySource ? `${label}: the source reported a truncated result set.` : "";
    return { rows, note, available };
  }
  const sourcePart = truncatedBySource ? " The source also reported a truncated result set." : "";
  return {
    rows: rows.slice(0, MAX_ROWS_PER_SOURCE),
    note: `${label}: showing the first ${MAX_ROWS_PER_SOURCE} of ${available.toLocaleString("en-US")} records.${sourcePart}`,
    available,
  };
}

export type BadgeVariant = "default" | "destructive" | "outline" | "secondary";

export interface StatusBadge {
  variant: BadgeVariant;
  text: string;
}

/** Badge presentation for a source outcome. Destructive means "do not trust this". */
export function statusBadge(outcome: SourceOutcome): StatusBadge {
  switch (outcome) {
    case "findings":
      return { variant: "default", text: "records found" };
    case "no_records":
      return { variant: "secondary", text: "no records" };
    case "not_configured":
      return { variant: "outline", text: "not in use here" };
    case "unavailable":
      return { variant: "destructive", text: "could not answer" };
    case "unknown_status":
      return { variant: "destructive", text: "result not understood" };
  }
}

/**
 * Badge for the whole block.
 *
 * `no_records` is the normal healthy outcome and stays muted — a red badge here
 * would tell the operator a clean sweep went wrong. `incomplete` is red because
 * coverage was partial and "no records found" would be an overstatement.
 */
export function headlineBadge(outcome: HistoryOutcome): StatusBadge {
  switch (outcome) {
    case "findings":
      return { variant: "default", text: "records found" };
    case "no_records":
      return { variant: "secondary", text: "no records found" };
    case "incomplete":
      return { variant: "destructive", text: "incomplete coverage" };
  }
}

function urlscanRows(rows: Record<string, unknown>[]): HistoryRow[] {
  return rows.map((f, i) => {
    const page = clipText(f.page_url, 80);
    return {
      id: `urlscan-${i}`,
      cells: [
        { label: "Verdict", value: asPlainText(f.verdict) || "—" },
        {
          label: "Scanned page",
          value: page.text,
          mono: true,
          truncated: page.truncated,
          href: safeHttpsUrl(f.page_url),
        },
        { label: "Scan UUID", value: clipText(f.task_uuid, 40).text, mono: true },
      ],
    };
  });
}

function otxRows(rows: Record<string, unknown>[]): HistoryRow[] {
  return rows.map((f, i) => {
    // TLP amber/red pulses are non-public: the backend withholds the name and
    // description and flags `tlp_restricted`. Showing the pulse id and dates
    // keeps the row useful without displaying restricted content.
    const restricted = f.tlp_restricted === true;
    const name = clipText(f.name, PULSE_PREVIEW_CHARS);
    const description = clipText(f.description, PULSE_DESCRIPTION_CHARS);
    return {
      id: `otx-${asPlainText(f.pulse_id) || i}`,
      cells: [
        {
          label: "Pulse",
          value: restricted ? "withheld (TLP restricted)" : name.text || "—",
          truncated: !restricted && name.truncated,
        },
        {
          label: "Description",
          value: restricted ? "withheld (TLP restricted)" : description.text || "—",
          truncated: !restricted && description.truncated,
        },
        { label: "Created", value: asPlainText(f.created) || "—" },
        { label: "TLP", value: asPlainText(f.tlp) || "—" },
        { label: "Author", value: clipText(f.author, 60).text || "—" },
        { label: "Malware", value: formatList(f.malware_families, 4).text || "—" },
        { label: "Adversary", value: clipText(f.adversary, 60).text || "—" },
      ],
    };
  });
}

function leaklookupRows(rows: Record<string, unknown>[]): HistoryRow[] {
  return rows.map((f, i) => {
    const name = clipText(f.name, 120);
    return {
      id: `leaklookup-${i}`,
      cells: [
        { label: "Breach", value: name.text || "—", truncated: name.truncated },
        { label: "Breach date", value: asPlainText(f.date) || "—" },
        { label: "Records", value: formatCount(f.matches) },
      ],
    };
  });
}

const ROW_BUILDERS: Record<HistorySourceKey, (rows: Record<string, unknown>[]) => HistoryRow[]> = {
  otx: otxRows,
  urlscan: urlscanRows,
  leaklookup: leaklookupRows,
};

/**
 * Classify one source and build its rows.
 *
 * `count: 0` with `status: "ok"` is "no records found" — the healthy outcome,
 * and never an error. `not_configured` is an operator state, distinct from
 * `unavailable` (the source failed). An unrecognised status is treated as
 * untrustworthy rather than clean.
 */
export function buildSource(key: HistorySourceKey, value: unknown): HistorySource {
  const block = isRecord(value) ? value : {};
  const label = SOURCE_LABELS[key];
  const rawStatus = asPlainText(block.status);
  const status: HistorySourceStatus | "unknown" =
    rawStatus === "ok" || rawStatus === "unavailable" || rawStatus === "not_configured" ? rawStatus : "unknown";

  const all = ROW_BUILDERS[key](records(block.findings));
  // `truncated` is the history-source flag; `counts_truncated` is the name other
  // sources in this codebase use for the same idea, so honour either.
  const truncatedBySource = block.truncated === true || block.counts_truncated === true;
  const { rows, note: truncationNote, available } = limitRows(all, truncatedBySource, label);
  const reportedCount = typeof block.count === "number" && Number.isFinite(block.count) ? block.count : all.length;
  const count = Math.max(reportedCount, all.length);

  let outcome: SourceOutcome;
  if (status === "unavailable") outcome = "unavailable";
  else if (status === "not_configured") outcome = "not_configured";
  else if (status === "unknown") outcome = "unknown_status";
  else if (all.length > 0) outcome = "findings";
  else outcome = "no_records";

  let message: string;
  switch (outcome) {
    case "findings":
      message = `${count.toLocaleString("en-US")} record${count === 1 ? "" : "s"} from this source.`;
      break;
    case "no_records":
      message = "No records found for this source.";
      break;
    case "not_configured":
      message = `${label} is switched off here, so nothing was searched there. That is how this installation is set up, not a source that failed.`;
      break;
    case "unavailable":
      message = `${label} could not be reached, so this source contributes nothing. Its contribution is unknown, not zero.`;
      break;
    case "unknown_status":
      message = `${label} sent back something we could not read, so we cannot tell whether it searched or failed. Treat the result as unknown, not as a clean one.`;
      break;
  }

  return {
    key,
    label,
    source: asPlainText(block.source) || label,
    status,
    outcome,
    count,
    message,
    note: asPlainText(block.note),
    rows,
    available,
    truncationNote,
    screenshotUrl: key === "urlscan" ? safeHttpsUrl(block.screenshot_url) : null,
    total: typeof block.total === "number" && Number.isFinite(block.total) ? block.total : null,
    windowDays:
      typeof block.window_days === "number" && Number.isFinite(block.window_days) ? block.window_days : null,
  };
}

/**
 * Aggregate outcome for the whole block.
 *
 *   findings   — at least one record; show the rows.
 *   no_records — every source that was supposed to run answered, and all said zero.
 *   incomplete — something was unreachable, unrecognised, or missing entirely,
 *                so "no records found" would be an overstatement.
 */
export function summarize(sources: HistorySource[]): HistorySummary {
  const findingCount = sources.reduce((sum, s) => sum + (s.outcome === "findings" ? s.count : 0), 0);
  const okSources = sources.filter((s) => s.outcome === "findings" || s.outcome === "no_records").length;
  const failedSources = sources.filter((s) => s.outcome === "unavailable" || s.outcome === "unknown_status").length;
  const unconfiguredSources = sources.filter((s) => s.outcome === "not_configured").length;

  let outcome: HistoryOutcome;
  let headline: string;
  if (findingCount > 0) {
    outcome = "findings";
    const records_ = findingCount.toLocaleString("en-US");
    headline = `${records_} threat record${findingCount === 1 ? "" : "s"} found.`;
  } else if (okSources === 0) {
    outcome = "incomplete";
    headline =
      sources.length === 0
        ? "No history source returned a result, so this target is unknown."
        : "No history source answered, so this target is unknown — not clean.";
  } else if (failedSources > 0) {
    outcome = "incomplete";
    headline = `No records from the ${okSources} source${okSources === 1 ? "" : "s"} that answered — ${failedSources} could not be checked.`;
  } else {
    outcome = "no_records";
    headline = "No threat records found.";
  }

  let detail: string;
  if (outcome === "findings") {
    detail = `Across ${okSources} source${okSources === 1 ? "" : "s"} that answered.`;
  } else if (outcome === "incomplete") {
    detail = `Partial coverage: ${okSources} source${okSources === 1 ? "" : "s"} answered, ${failedSources} could not answer, ${unconfiguredSources} switched off here. An incomplete sweep is not a clean result.`;
  } else if (unconfiguredSources > 0) {
    detail = `${okSources} source${okSources === 1 ? "" : "s"} answered with no records; ${unconfiguredSources} switched off here were never searched at all.`;
  } else {
    detail = `All ${okSources} sources answered and none has a record for this target.`;
  }

  return { outcome, headline, detail, findingCount, okSources, failedSources, unconfiguredSources };
}

/**
 * Narrow an unknown `results.history` value.
 *
 * Returns null (render nothing) when the block is absent, null, not an object,
 * explicitly not triggered, or has no `blocks` object — in every one of those
 * cases we cannot tell whether the sources ran, and guessing would be a lie.
 * An empty `blocks: {}` IS valid and renders the empty state.
 */
export function parseThreatHistory(input: unknown): ThreatHistory | null {
  if (!isRecord(input)) return null;
  if (input.triggered === false) return null;
  if (!isRecord(input.blocks)) return null;

  const sources: HistorySource[] = [];
  for (const key of SOURCE_KEYS) {
    // A source key that is absent from the payload gets no row at all.
    if (!(key in input.blocks)) continue;
    sources.push(buildSource(key, input.blocks[key]));
  }

  const errors: HistorySourceError[] = [];
  if (Array.isArray(input.errors)) {
    for (const e of input.errors) {
      if (!isRecord(e)) continue;
      const source = asPlainText(e.source);
      const message = asPlainText(e.message);
      if (!source && !message) continue;
      // No source name and no reason: neither is rendered raw (see
      // ThreatHistoryCard), so the placeholders only need to be honest about
      // being placeholders rather than echoing plumbing.
      errors.push({
        source: source || "Another lookup",
        message: message || "did not answer",
      });
    }
  }

  const summary = summarize(sources);
  // A source-level error with no block at all still means coverage is partial.
  if (summary.outcome === "no_records" && errors.length > 0) {
    summary.outcome = "incomplete";
    summary.headline = "No threat records found by the sources that answered, but part of the sweep failed.";
    summary.detail = `Partial coverage: ${summary.okSources} source${summary.okSources === 1 ? "" : "s"} answered, ${errors.length} failed.`;
  }

  return {
    source: asPlainText(input.source) || "Threat & incident history",
    triggerReason: asPlainText(input.trigger_reason),
    note: asPlainText(input.note),
    sources,
    errors,
    summary,
    headline: summary.headline,
    detail: summary.detail,
  };
}