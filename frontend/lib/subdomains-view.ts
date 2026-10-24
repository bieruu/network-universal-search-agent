/**
 * crt.sh names, cleansed without lying.
 *
 * The certificate log returns one entry per (name, certificate) pair, so the
 * same subdomain shows up once per certificate ever issued for it, and every
 * entry carries validity dates that are frequently in the past. Two changes are
 * needed - merge the duplicates, and mark which names are served by a
 * certificate that has already expired - and both have the same failure mode:
 * if a merged or relabelled row is dropped quietly, the table stops being a
 * record of what the source said. So this module never drops and never hides:
 *
 *  - duplicates are merged into the first appearance of the name, and the count
 *    of merged entries travels with the view;
 *  - expired names keep their row and carry an "Expired" label;
 *  - a name whose dates cannot be read is `unknown` - never "active", because
 *    an unreadable date is not evidence that a certificate is current;
 *  - pagination is a page, not a cap, and every view states how many names are
 *    not on the screen.
 *
 * The export builders (lib/export-findings.ts) read the same view, so the file
 * a user downloads cannot disagree with the table they were just looking at.
 */

import type { ScanResult } from "./api.ts";
import { getSubdomains } from "./scan-shape.ts";
import { asPlainText } from "./threat-history-shape.ts";
import { plural } from "./terms.ts";

/** How valid a name's certificate is right now, from its own dates. */
export type SubdomainValidity = "active" | "expired" | "unknown";

/** Filter choices for the table. `all` is the default and hides nothing. */
export type SubdomainFilter = "all" | SubdomainValidity;

export interface SubdomainRow {
  subdomain: string;
  issuer: string | null;
  not_before: string | null;
  not_after: string | null;
  validity: SubdomainValidity;
  /** Raw log entries that carried this same name and were merged into it. */
  merged: number;
}

export interface SubdomainsView {
  /** Deduplicated names, in the order the source first listed them. */
  rows: SubdomainRow[];
  /** Rows the log returned before cleansing. */
  reported: number;
  /** Distinct names (rows.length). */
  unique: number;
  /** `reported - unique`: entries that repeated a name already listed. */
  duplicatesMerged: number;
  active: number;
  expired: number;
  /** Dates missing or unreadable, or a certificate that has not started yet. */
  unknown: number;
}

/** Rows per page. A page, not a cap - the hidden count is always stated. */
export const MAX_ROWS = 50;

const SUBDOMAIN_FILTER_LABELS: Record<SubdomainFilter, string> = {
  all: "All names",
  active: "Active",
  expired: "Expired",
  unknown: "Dates unreadable",
};

export function subdomainFilterLabel(filter: SubdomainFilter): string {
  return SUBDOMAIN_FILTER_LABELS[filter] ?? SUBDOMAIN_FILTER_LABELS.all;
}

/** Badge text for the validity column. Short enough for a table cell. */
export function subdomainValidityLabel(validity: SubdomainValidity): string {
  switch (validity) {
    case "active":
      return "Active";
    case "expired":
      return "Expired";
    default:
      return "Unknown";
  }
}

/** One explanation, reused by the badge's `title` and by the export. */
export function subdomainValidityNote(validity: SubdomainValidity): string {
  switch (validity) {
    case "active":
      return "A certificate for this name is inside its validity window right now.";
    case "expired":
      return "The certificate has expired, but the name is still in the log, so it is shown.";
    default:
      return "Dates are missing or unreadable, so this name is unknown - not expired or confirmed active.";
  }
}

/** Milliseconds for a date string, or `null` when it cannot be read. */
function parseDate(value: unknown): number | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Active / expired from the certificate's own dates.
 *
 * `unknown` is the honest answer for a date that cannot be read, and also for a
 * certificate whose validity window has not started yet - neither of those is
 * evidence that a certificate is current, which is what "active" would claim.
 */
export function classifyValidity(row: { not_before?: string; not_after?: string }, now: Date): SubdomainValidity {
  const notAfter = parseDate(row.not_after);
  if (notAfter == null) return "unknown";
  if (notAfter < now.getTime()) return "expired";
  const notBefore = parseDate(row.not_before);
  if (notBefore != null && notBefore > now.getTime()) return "unknown";
  return "active";
}

/**
 * Deduplicate and classify the crt.sh rows for one scan.
 *
 * The surviving row for a name is the one whose `not_after` reads latest: a name
 * served by a certificate that has not expired is active even though an older
 * certificate for the same name has lapsed. When no date is readable at all the
 * first occurrence wins, so nothing is invented.
 */
export function normalizeSubdomains(results: ScanResult["results"] | null | undefined): SubdomainsView {
  type Kept = { row: (typeof rawRows)[number]; count: number };
  const rawRows = getSubdomains(results);

  const byName = new Map<string, Kept>();
  let reported = 0;
  for (const entry of rawRows) {
    const name = asPlainText(entry?.subdomain);
    if (!name) continue;
    reported += 1;
    const key = name.toLowerCase();
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, { row: entry, count: 1 });
      continue;
    }
    existing.count += 1;
    const keptAfter = parseDate(existing.row.not_after) ?? Number.NEGATIVE_INFINITY;
    const nextAfter = parseDate(entry.not_after) ?? Number.NEGATIVE_INFINITY;
    if (nextAfter > keptAfter) existing.row = entry;
  }

  let active = 0;
  let expired = 0;
  let unknown = 0;
  const rows: SubdomainRow[] = [];
  for (const { row: entry, count } of byName.values()) {
    const validity = classifyValidity(entry, new Date());
    if (validity === "active") active += 1;
    else if (validity === "expired") expired += 1;
    else unknown += 1;
    rows.push({
      subdomain: asPlainText(entry.subdomain),
      issuer: entry.issuer ? asPlainText(entry.issuer) : null,
      not_before: entry.not_before ? asPlainText(entry.not_before) : null,
      not_after: entry.not_after ? asPlainText(entry.not_after) : null,
      validity,
      merged: count,
    });
  }

  return {
    rows,
    reported,
    unique: rows.length,
    duplicatesMerged: Math.max(0, reported - rows.length),
    active,
    expired,
    unknown,
  };
}

export function filterSubdomainRows(rows: SubdomainRow[], filter: SubdomainFilter): SubdomainRow[] {
  return filter === "all" ? rows : rows.filter((r) => r.validity === filter);
}

export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/**
 * What was merged or relabelled to produce these rows, in one sentence.
 *
 * This is the sentence that keeps cleansing honest: it is rendered under the
 * table and it is written into the export, so neither surface can quietly
 * present a deduplicated list as the log's own output.
 */
export function subdomainsCountsNote(view: SubdomainsView): string {
  const parts: string[] = [];
  if (view.duplicatesMerged > 0) {
    parts.push(
      `${view.duplicatesMerged.toLocaleString("en-US")} duplicate ${plural(view.duplicatesMerged, "entry", "entries")} from the certificate log ${plural(view.duplicatesMerged, "was", "were")} merged into the first appearance of the same name`,
    );
  }
  if (view.expired > 0) {
    parts.push(
      `${view.expired.toLocaleString("en-US")} ${plural(view.expired, "name", "names")} ${plural(view.expired, "carries", "carry")} a certificate that has already expired and ${view.expired === 1 ? "is labelled, not hidden" : "are labelled, not hidden"}`,
    );
  }
  if (view.unknown > 0) {
    parts.push(
      `${view.unknown.toLocaleString("en-US")} ${plural(view.unknown, "name", "names")} ${view.unknown === 1 ? "has" : "have"} validity dates that could not be read, so ${view.unknown === 1 ? "it is" : "they are"} unknown rather than active`,
    );
  }
  if (parts.length === 0) return "";
  return `${parts.join("; ")}.`;
}

export interface SubdomainsVisibility {
  filter: SubdomainFilter;
  /** Names the current filter leaves. */
  visible: number;
  /** Names the current filter hid. */
  hiddenByFilter: number;
  /** Names on this page. */
  shown: number;
  /** Names not on this page (they exist, on other pages). */
  hiddenByPage: number;
  /** Zero-based page index, clamped into range. */
  page: number;
  pages: number;
  /** One-based position of the first row on this page; 0 when nothing matches. */
  firstOnPage: number;
  lastOnPage: number;
  duplicatesMerged: number;
  expired: number;
  unknown: number;
  /** Which names are on screen and how many are not. */
  rowNote: string;
  /** What was merged or relabelled, and why. */
  honestyNote: string;
}

/**
 * Everything the table has to say about its own coverage.
 *
 * `rowNote` never lets a filtered or paged list read as the whole result, and
 * `honestyNote` is `subdomainsCountsNote` with the filter's effect added - an
 * expired name that the current filter hides must say so, because "Expired:
 * 15" next to zero visible expired rows is a lie either way.
 */
export function subdomainsVisibility(
  view: SubdomainsView,
  filter: SubdomainFilter,
  requestedPage: number,
  pageSize: number = MAX_ROWS,
): SubdomainsVisibility {
  const filtered = filterSubdomainRows(view.rows, filter);
  const pages = pageCount(filtered.length, pageSize);
  const page = Math.min(Math.max(0, requestedPage), pages - 1);
  const start = page * pageSize;
  const shown = filtered.slice(start, start + pageSize);
  const hiddenByPage = filtered.length - shown.length;
  const hiddenByFilter = view.unique - filtered.length;

  const label = subdomainFilterLabel(filter).toLowerCase();
  let rowNote: string;
  if (filtered.length === 0) {
    rowNote =
      filter === "all"
        ? ""
        : `No names match this filter. ${hiddenByFilter.toLocaleString("en-US")} of ${view.unique.toLocaleString("en-US")} ${plural(view.unique, "name", "names")} ${plural(view.unique, "is", "are")} hidden by it.`;
  } else if (pages === 1) {
    rowNote = `All ${filtered.length.toLocaleString("en-US")} matching ${plural(filtered.length, "name", "names")} are shown.`;
  } else if (page === 0) {
    rowNote = `Showing 1 to ${shown.length.toLocaleString("en-US")} of ${filtered.length.toLocaleString("en-US")} names. ${hiddenByPage.toLocaleString("en-US")} more on ${pages - 1} ${plural(pages - 1, "page", "pages")}.`;
  } else {
    rowNote = `Showing ${start + 1} to ${(start + shown.length).toLocaleString("en-US")} of ${filtered.length.toLocaleString("en-US")} names. ${hiddenByPage.toLocaleString("en-US")} more on other pages.`;
  }

  const honestyParts: string[] = [];
  const counts = subdomainsCountsNote(view);
  if (counts) honestyParts.push(counts);
  if (hiddenByFilter > 0) {
    honestyParts.push(
      `The "${label}" filter hides ${hiddenByFilter.toLocaleString("en-US")} of ${view.unique.toLocaleString("en-US")} ${plural(view.unique, "name", "names")}. Choose all names to see every one.`,
    );
  }

  return {
    filter,
    visible: filtered.length,
    hiddenByFilter,
    shown: shown.length,
    hiddenByPage,
    page,
    pages,
    firstOnPage: filtered.length === 0 ? 0 : start + 1,
    lastOnPage: start + shown.length,
    duplicatesMerged: view.duplicatesMerged,
    expired: view.expired,
    unknown: view.unknown,
    rowNote,
    honestyNote: honestyParts.join(" "),
  };
}
