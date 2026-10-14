import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_ROWS,
  classifyValidity,
  filterSubdomainRows,
  normalizeSubdomains,
  pageCount,
  subdomainFilterLabel,
  subdomainValidityLabel,
  subdomainValidityNote,
  subdomainsCountsNote,
  subdomainsVisibility,
} from "./subdomains-view.ts";
import type { ScanResult } from "./api.ts";

/**
 * The crt.sh cleansing contract.
 *
 * The log returns one row per (name, certificate) pair, so cleansing has to
 * merge duplicates and label certificates that have expired. Both changes have
 * the same failure mode — a quiet drop — so every test here checks the two
 * numbers that make the drop visible: how many rows the source sent, and how
 * many the view is not showing.
 */

/** Fixed clock, so "expired" cannot become "active" next year. */
const NOW = new Date("2026-10-14T12:00:00.000Z");
const FUTURE = "2099-01-01T00:00:00Z";
const PAST = "2001-01-01T00:00:00Z";

/** A crtsh block typed as the backend sends it — deliberately loose, because
 *  the test feeds it junk as well as well-formed rows. */
function results(subdomains: Array<Record<string, unknown>>): ScanResult["results"] {
  return { crtsh: { domain: "example.com", subdomains } } as unknown as ScanResult["results"];
}

function row(subdomain: string, after: string | undefined, before = "2026-01-01T00:00:00Z") {
  return { subdomain, issuer: "Test CA", not_before: before, not_after: after };
}

/* ------------------------------------------------------------------ *
 * Classification
 * ------------------------------------------------------------------ */

test("validity comes from the certificate's own dates", () => {
  assert.equal(classifyValidity({ not_before: "2026-01-01T00:00:00Z", not_after: FUTURE }, NOW), "active");
  assert.equal(classifyValidity({ not_before: "2020-01-01T00:00:00Z", not_after: PAST }, NOW), "expired");
});

test("an unreadable or missing date is unknown, never active", () => {
  assert.equal(classifyValidity({ not_before: "2026-01-01T00:00:00Z" }, NOW), "unknown");
  assert.equal(classifyValidity({}, NOW), "unknown");
  assert.equal(classifyValidity({ not_after: "not a date" }, NOW), "unknown");
  // A certificate that has not started yet is not evidence that one is current.
  assert.equal(classifyValidity({ not_before: "2099-01-01T00:00:00Z", not_after: "2099-02-01T00:00:00Z" }, NOW), "unknown");
});

test("the expiry boundary is inclusive: exactly now is still active", () => {
  // A certificate is valid at the instant it expires; one millisecond later it
  // is not. The classification uses the same rule at the boundary, so the two
  // rows below cannot flip between runs on either side of midnight.
  assert.equal(classifyValidity({ not_after: NOW.toISOString() }, NOW), "active");
  assert.equal(classifyValidity({ not_after: new Date(NOW.getTime() + 1).toISOString() }, NOW), "active");
  assert.equal(classifyValidity({ not_after: new Date(NOW.getTime() - 1).toISOString() }, NOW), "expired");
});

test("each validity has a short label and a note that explains itself", () => {
  assert.equal(subdomainValidityLabel("active"), "Active");
  assert.equal(subdomainValidityLabel("expired"), "Expired");
  assert.equal(subdomainValidityLabel("unknown"), "Unknown");
  // The expired note has to say why the row is still on screen.
  assert.ok(subdomainValidityNote("expired").includes("shown here on purpose"), subdomainValidityNote("expired"));
  assert.ok(subdomainValidityNote("unknown").includes("not expired"), subdomainValidityNote("unknown"));
});

/* ------------------------------------------------------------------ *
 * Deduplication — the count travels, nothing is dropped
 * ------------------------------------------------------------------ */

test("duplicate names are merged and the merge is counted", () => {
  const view = normalizeSubdomains(
    results([
      row("a.example.com", FUTURE),
      row("b.example.com", FUTURE),
      row("a.example.com", FUTURE),
      row("a.example.com", FUTURE),
    ]),
  );
  assert.equal(view.reported, 4);
  assert.equal(view.unique, 2);
  assert.equal(view.duplicatesMerged, 2);
  assert.equal(view.rows.length, 2);
  assert.equal(view.rows.find((r) => r.subdomain === "a.example.com")?.merged, 3);
  assert.equal(view.rows.find((r) => r.subdomain === "b.example.com")?.merged, 1);
});

test("the surviving row for a name is the one whose certificate is still valid", () => {
  // The log listed the expired certificate first. Merging by "the latest
  // not_after wins" keeps the name active instead of reporting a live host as
  // expired — and it is a merge, not a drop, so the duplicate count still says
  // the log sent two rows.
  const view = normalizeSubdomains(
    results([row("a.example.com", PAST), row("a.example.com", FUTURE)]),
  );
  assert.equal(view.unique, 1);
  assert.equal(view.duplicatesMerged, 1);
  assert.equal(view.rows[0].validity, "active");
  assert.equal(view.rows[0].not_after, FUTURE);
  assert.equal(view.active, 1);
  assert.equal(view.expired, 0);
});

test("an expired name is kept and labelled, not dropped", () => {
  const view = normalizeSubdomains(
    results([row("old.example.com", PAST), row("live.example.com", FUTURE)]),
  );
  assert.equal(view.rows.length, 2, "an expired row must survive cleansing");
  assert.equal(view.expired, 1);
  assert.equal(view.active, 1);
  assert.equal(view.rows.find((r) => r.subdomain === "old.example.com")?.validity, "expired");
  // Order is the source's order, so the table does not reorder what was read.
  assert.deepEqual(view.rows.map((r) => r.subdomain), ["old.example.com", "live.example.com"]);
});

test("names that differ only by case are the same name", () => {
  const view = normalizeSubdomains(results([row("A.Example.com", FUTURE), row("a.example.com", FUTURE)]));
  assert.equal(view.unique, 1);
  assert.equal(view.duplicatesMerged, 1);
  assert.equal(view.rows[0].merged, 2);
});

test("empty, missing and malformed logs produce no rows and no crash", () => {
  assert.deepEqual(normalizeSubdomains(null).rows, []);
  assert.deepEqual(normalizeSubdomains({}).rows, []);
  assert.deepEqual(normalizeSubdomains({ crtsh: { count: 9 } }).rows, []);
  assert.deepEqual(normalizeSubdomains(results([])).rows, []);
  const view = normalizeSubdomains(results([{ issuer: "no name" }, { subdomain: "  " }, row("ok.example.com", FUTURE)]));
  assert.equal(view.reported, 1, "a row with no name is not a row");
  assert.equal(view.unique, 1);
});

test("a legacy bare-array crtsh payload still reads", () => {
  // The backend used to hand back a bare list; scan-shape tolerates it, so the
  // cleansed view must too.
  const view = normalizeSubdomains({ crtsh: [row("a.example.com", FUTURE)] } as unknown as ScanResult["results"]);
  assert.equal(view.unique, 1);
});

/* ------------------------------------------------------------------ *
 * Honesty notes
 * ------------------------------------------------------------------ */

test("the counts note names the merge, the expiry and the unreadable dates", () => {
  const view = normalizeSubdomains(
    results([
      row("a.example.com", PAST),
      row("a.example.com", FUTURE),
      row("expired.example.com", PAST),
      row("mystery.example.com", undefined),
    ]),
  );
  assert.equal(view.reported, 4);
  assert.equal(view.unique, 3);
  assert.equal(view.duplicatesMerged, 1);
  assert.equal(view.expired, 1);
  assert.equal(view.unknown, 1);
  const note = subdomainsCountsNote(view);
  assert.ok(note.includes("1 duplicate entry"), note);
  assert.ok(note.includes("1 name carries a certificate that has already expired and is labelled, not hidden"), note);
  assert.ok(note.includes("1 name has validity dates that could not be read"), note);
});

test("a clean log produces no note at all", () => {
  const view = normalizeSubdomains(results([row("a.example.com", FUTURE)]));
  assert.equal(subdomainsCountsNote(view), "");
});

/* ------------------------------------------------------------------ *
 * Pagination — the page is a page, and the hidden count is stated
 * ------------------------------------------------------------------ */

test("pageCount never returns zero pages", () => {
  assert.equal(pageCount(0, MAX_ROWS), 1);
  assert.equal(pageCount(1, MAX_ROWS), 1);
  assert.equal(pageCount(MAX_ROWS, MAX_ROWS), 1);
  assert.equal(pageCount(MAX_ROWS + 1, MAX_ROWS), 2);
  assert.equal(pageCount(500, MAX_ROWS), 10);
});

function manyNames(n: number) {
  return Array.from({ length: n }, (_, i) => row(`a${i}.example.com`, FUTURE));
}

test("the first page says how many names are hidden behind it", () => {
  const view = normalizeSubdomains(results(manyNames(120)));
  const v = subdomainsVisibility(view, "all", 0);
  assert.equal(v.pages, 3);
  assert.equal(v.shown, MAX_ROWS);
  assert.equal(v.hiddenByPage, 70);
  assert.equal(v.hiddenByFilter, 0);
  assert.equal(v.firstOnPage, 1);
  assert.equal(v.lastOnPage, 50);
  // The existing contract sentence: "Showing the first ..." — kept verbatim.
  assert.match(v.rowNote, /^Showing the first 50 of 120 names — 70 hidden on 2 more pages\.$/);
});

test("the second page names its own range and still states the hidden count", () => {
  const view = normalizeSubdomains(results(manyNames(120)));
  const v = subdomainsVisibility(view, "all", 1);
  assert.equal(v.shown, MAX_ROWS);
  assert.equal(v.firstOnPage, 51);
  assert.equal(v.lastOnPage, 100);
  assert.equal(v.hiddenByPage, 70);
  assert.match(v.rowNote, /^Showing 51–100 of 120 names — 70 hidden on other pages\.$/);
});

test("a single page says it is showing everything", () => {
  const view = normalizeSubdomains(results(manyNames(12)));
  const v = subdomainsVisibility(view, "all", 0);
  assert.equal(v.pages, 1);
  assert.equal(v.hiddenByPage, 0);
  assert.match(v.rowNote, /^All 12 matching names are shown\.$/);
});

test("a page past the end is clamped, never empty-and-silent", () => {
  const view = normalizeSubdomains(results(manyNames(120)));
  const v = subdomainsVisibility(view, "all", 99);
  assert.equal(v.page, 2, "the requested page is clamped into range");
  assert.equal(v.pages, 3);
  assert.equal(v.shown, 20, "the last page holds the remainder");
  assert.equal(v.firstOnPage, 101);
  // Everything not on this page is "hidden by the page", whichever side of the
  // list it sits on — the count is a total, not a remainder.
  assert.equal(v.hiddenByPage, 100);
  assert.match(v.rowNote, /^Showing 101–120 of 120 names — 100 hidden on other pages\.$/);
});

test("MAX_ROWS is a page size, and a longer one only moves the same rows", () => {
  const view = normalizeSubdomains(results(manyNames(120)));
  const all = subdomainsVisibility(view, "all", 0, 200);
  assert.equal(all.pages, 1);
  assert.equal(all.shown, 120);
  assert.equal(all.hiddenByPage, 0);
  assert.match(all.rowNote, /^All 120 matching names are shown\.$/);
});

/* ------------------------------------------------------------------ *
 * Filters — every filter states what it hides
 * ------------------------------------------------------------------ */

function mixed() {
  return normalizeSubdomains(
    results([
      row("live1.example.com", FUTURE),
      row("old1.example.com", PAST),
      row("live2.example.com", FUTURE),
      row("old2.example.com", PAST),
      row("old3.example.com", PAST),
      row("mystery.example.com", undefined),
    ]),
  );
}

test("filters split the same rows without changing the universe", () => {
  const view = mixed();
  assert.equal(view.unique, 6);
  assert.equal(view.active, 2);
  assert.equal(view.expired, 3);
  assert.equal(view.unknown, 1);
  assert.equal(filterSubdomainRows(view.rows, "all").length, 6);
  assert.equal(filterSubdomainRows(view.rows, "active").length, 2);
  assert.equal(filterSubdomainRows(view.rows, "expired").length, 3);
  assert.equal(filterSubdomainRows(view.rows, "unknown").length, 1);
});

test("every filter has a label, and the default hides nothing", () => {
  assert.equal(subdomainFilterLabel("all"), "All names");
  assert.equal(subdomainFilterLabel("active"), "Active");
  assert.equal(subdomainFilterLabel("expired"), "Expired");
  assert.equal(subdomainFilterLabel("unknown"), "Dates unreadable");
  const v = subdomainsVisibility(mixed(), "all", 0);
  assert.equal(v.hiddenByFilter, 0);
  assert.equal(v.honestyNote, subdomainsCountsNote(mixed()));
});

test("an active-only filter states how many expired names it is hiding", () => {
  const view = mixed();
  const v = subdomainsVisibility(view, "active", 0);
  assert.equal(v.visible, 2);
  assert.equal(v.hiddenByFilter, 4);
  assert.match(v.rowNote, /^All 2 matching names are shown\.$/);
  // The whole point: the screen must not read as "there are 2 subdomains".
  assert.match(v.honestyNote, /The "active" filter is hiding 4 of 6 names; choose all names to see every one\./);
  assert.ok(v.honestyNote.includes("3 names carry a certificate that has already expired"), v.honestyNote);
});

test("the expired filter shows exactly the expired rows and says so", () => {
  const view = mixed();
  const v = subdomainsVisibility(view, "expired", 0);
  assert.equal(v.visible, 3);
  assert.equal(v.hiddenByFilter, 3);
  assert.match(v.rowNote, /^All 3 matching names are shown\.$/);
  assert.ok(v.honestyNote.includes("hide 3 of 6 names") === false, "the filter hides the other 3, not itself");
  assert.match(v.honestyNote, /The "expired" filter is hiding 3 of 6 names/);
});

test("a filter with no matches still reports the whole universe", () => {
  const view = normalizeSubdomains(results([row("live.example.com", FUTURE)]));
  const v = subdomainsVisibility(view, "expired", 0);
  assert.equal(v.visible, 0);
  assert.equal(v.shown, 0);
  assert.equal(v.hiddenByFilter, 1);
  assert.equal(v.firstOnPage, 0);
  assert.match(v.rowNote, /^No names match this filter — 1 of 1 name is hidden by it\.$/);
  assert.ok(v.honestyNote.includes("Nothing was removed from the scan"), v.honestyNote);
});

test("a filter and a page can both hide rows, and both are counted", () => {
  const view = normalizeSubdomains(
    results([
      ...Array.from({ length: 70 }, (_, i) => row(`old${i}.example.com`, PAST)),
      ...Array.from({ length: 30 }, (_, i) => row(`live${i}.example.com`, FUTURE)),
    ]),
  );
  const v = subdomainsVisibility(view, "expired", 0);
  assert.equal(v.visible, 70);
  assert.equal(v.pages, 2);
  assert.equal(v.shown, MAX_ROWS);
  assert.equal(v.hiddenByPage, 20, "the rows past the page are hidden by the page");
  assert.equal(v.hiddenByFilter, 30, "and the filtered-out rows are hidden by the filter");
  assert.match(v.rowNote, /^Showing the first 50 of 70 names — 20 hidden on 1 more page\.$/);
  assert.match(v.honestyNote, /The "expired" filter is hiding 30 of 100 names/);
  // The table's caption ("Showing the first ... of ...") is the same sentence
  // the pre-pagination contract required, so a paged and filtered list can
  // never read as the log's own output.
  assert.ok(v.rowNote.startsWith("Showing the first"));
});

test("the view never lets a hidden expired row disappear from the counts", () => {
  const view = mixed();
  // Even when every visible row is active, the expired count is still on the
  // object the table and the export both read.
  const v = subdomainsVisibility(view, "active", 0);
  assert.equal(v.expired, 3);
  assert.equal(v.unknown, 1);
  assert.equal(v.duplicatesMerged, 0);
});
