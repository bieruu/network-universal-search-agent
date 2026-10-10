import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_ROWS_PER_SOURCE,
  PULSE_DESCRIPTION_CHARS,
  PULSE_PREVIEW_CHARS,
  SAFETY_CAVEAT,
  asPlainText,
  buildSource,
  clipText,
  formatList,
  headlineBadge,
  parseThreatHistory,
  safeHttpsUrl,
  statusBadge,
  summarize,
} from "./threat-history-shape.ts";

const here = dirname(fileURLToPath(import.meta.url));

// Backend truth: orchestrator._threat_history_fallback, plus the seven-key
// source contract each service returns (source/status/count/findings/truncated/note).
const block = (over: Record<string, unknown> = {}) => ({
  source: "Threat & incident history",
  triggered: true,
  trigger_reason: "No CVE data was available for this target",
  note: "Absence of CVEs is not evidence of safety.",
  blocks: {},
  errors: [],
  ...over,
});

const okSource = (over: Record<string, unknown> = {}) => ({
  source: "Leak-Lookup",
  status: "ok",
  count: 0,
  findings: [],
  truncated: false,
  note: "",
  ...over,
});

test("missing history yields nothing to render", () => {
  assert.equal(parseThreatHistory(undefined), null);
  assert.equal(parseThreatHistory(null), null);
  assert.equal(parseThreatHistory({}), null);
  assert.equal(parseThreatHistory("history"), null);
  assert.equal(parseThreatHistory([]), null);
  assert.equal(parseThreatHistory(42), null);
});

test("history that did not trigger renders nothing", () => {
  assert.equal(parseThreatHistory(block({ triggered: false })), null);
  // A populated CVE list means history never ran, so the block is absent entirely.
  assert.equal(parseThreatHistory({ nvd: { status: "found", cves: [{ id: "CVE-2021-41773" }] } }), null);
});

test("triggered history with an empty blocks object is valid", () => {
  const parsed = parseThreatHistory(block({ blocks: {} }));
  assert.ok(parsed, "an empty sweep still renders the empty state");
  assert.deepEqual(parsed!.sources, []);
  assert.equal(parsed!.summary.outcome, "incomplete");
});

test("malformed blocks do not throw", () => {
  for (const bad of [null, "blocks", 7, [1, 2], () => {}]) {
    const parsed = parseThreatHistory(block({ blocks: bad }));
    assert.equal(parsed, null, `blocks=${JSON.stringify(bad) ?? String(bad)} must render nothing`);
  }
  // A present-but-garbage source is kept as a row rather than crashing the card.
  const parsed = parseThreatHistory(block({ blocks: { otx: "nope", urlscan: null, leaklookup: 3 } }));
  assert.ok(parsed);
  assert.equal(parsed!.sources.length, 3);
  for (const s of parsed!.sources) assert.equal(s.outcome, "unknown_status");
});

test("a source key that is absent gets no row", () => {
  const parsed = parseThreatHistory(block({ blocks: { leaklookup: okSource() } }));
  assert.deepEqual(parsed!.sources.map((s) => s.key), ["leaklookup"]);
});

test("status ok with count 0 is 'no records', never an error", () => {
  const src = buildSource("leaklookup", okSource());
  assert.equal(src.outcome, "no_records");
  assert.equal(src.count, 0);
  assert.equal(src.message, "No records found for this source.");
  const badge = statusBadge(src.outcome);
  assert.equal(badge.variant, "secondary");
  assert.notEqual(badge.variant, "destructive");
});

test("not_configured is distinct from unavailable and is not an error", () => {
  const off = buildSource("leaklookup", { status: "not_configured", note: "LEAKLOOKUP_API_KEY is not set." });
  const dead = buildSource("leaklookup", { status: "unavailable", note: "HTTP 429 from leak-lookup.com." });

  assert.equal(off.outcome, "not_configured");
  assert.equal(dead.outcome, "unavailable");
  assert.notEqual(off.outcome, dead.outcome);
  // Operator configuration state: muted, and the source's own note is surfaced.
  assert.equal(statusBadge(off.outcome).variant, "outline");
  assert.match(off.message, /switched off here/);
  assert.equal(off.note, "LEAKLOOKUP_API_KEY is not set.");
  // Actual failure: red, and it says the contribution is unknown rather than zero.
  assert.equal(statusBadge(dead.outcome).variant, "destructive");
  assert.match(dead.message, /unknown, not zero/);
  assert.equal(dead.note, "HTTP 429 from leak-lookup.com.");
});

test("an unrecognised status is not treated as clean", () => {
  const weird = buildSource("leaklookup", { status: "partially_ok", findings: [], count: 0 });
  assert.equal(weird.status, "unknown");
  assert.equal(weird.outcome, "unknown_status");
  assert.equal(statusBadge(weird.outcome).variant, "destructive");
  assert.match(weird.message, /not as a clean one/);
});

test("the all-empty sweep is the healthy normal case, not a failure", () => {
  const parsed = parseThreatHistory(
    block({
      blocks: {
        otx: { source: "AlienVault OTX", status: "ok", count: 0, findings: [], truncated: false, note: "No pulses mention this indicator." },
        urlscan: { source: "URLScan.io", status: "ok", count: 0, findings: [], truncated: false, note: "No public scans matched." },
        leaklookup: { source: "Leak-Lookup", status: "ok", count: 0, findings: [], truncated: false, note: "No indexed leaks." },
      },
    }),
  );
  assert.ok(parsed);
  assert.equal(parsed!.summary.outcome, "no_records");
  assert.equal(parsed!.headline, "No threat records found.");
  assert.equal(headlineBadge(parsed!.summary.outcome).variant, "secondary");
  assert.equal(parsed!.errors.length, 0);
  // Never implies safety.
  assert.doesNotMatch(parsed!.headline, /safe|clean|no risk/i);
  assert.ok(SAFETY_CAVEAT.includes("not evidence the target is safe"));
});

test("findings state renders rows and keeps the trigger reason", () => {
  const parsed = parseThreatHistory(
    block({
      blocks: {
        leaklookup: {
          source: "Leak-Lookup",
          status: "ok",
          count: 1,
          findings: [{ name: "AcmeLeak", date: "2021-05-01", matches: 123456 }],
          truncated: false,
          note: "",
        },
        urlscan: { status: "ok", count: 0, findings: [], note: "" },
      },
    }),
  );
  assert.ok(parsed);
  assert.equal(parsed!.summary.outcome, "findings");
  assert.equal(parsed!.summary.findingCount, 1);
  assert.equal(parsed!.triggerReason, "No CVE data was available for this target");
  const leak = parsed!.sources.find((s) => s.key === "leaklookup")!;
  assert.equal(leak.outcome, "findings");
  assert.equal(leak.rows.length, 1);
  const cells = Object.fromEntries(leak.rows[0].cells.map((c) => [c.label, c.value]));
  assert.equal(cells.Breach, "AcmeLeak");
  assert.equal(cells["Breach date"], "2021-05-01");
  // Counts only: a leaked-pair source must never surface identities, so the
  // row carries no address and no hash column at all.
  assert.equal(cells.Records, "123,456");
  assert.ok(!Object.keys(cells).some((k) => /email|password|account|hash/i.test(k)));
});

test("an unreachable source downgrades a clean sweep to incomplete", () => {
  const parsed = parseThreatHistory(
    block({
      blocks: {
        leaklookup: okSource({ note: "No indexed leaks." }),
        otx: { status: "unavailable", count: 0, findings: [], note: "OTX throttled this IP" },
      },
    }),
  );
  assert.ok(parsed);
  assert.equal(parsed!.summary.outcome, "incomplete");
  assert.equal(parsed!.summary.okSources, 1);
  assert.equal(parsed!.summary.failedSources, 1);
  assert.equal(headlineBadge(parsed!.summary.outcome).variant, "destructive");
  assert.doesNotMatch(parsed!.headline, /^No threat records found\.$/);
  assert.match(parsed!.detail, /not a clean result/);
});

test("a source-level error with no rows is reported, not silently dropped", () => {
  const parsed = parseThreatHistory(
    block({
      blocks: { leaklookup: okSource() },
      errors: [{ source: "urlscan", message: "TimeoutError" }],
    }),
  );
  assert.ok(parsed);
  assert.deepEqual(parsed!.errors, [{ source: "urlscan", message: "TimeoutError" }]);
  assert.equal(parsed!.summary.outcome, "incomplete");
  // Garbage entries are skipped, not rendered.
  const junk = parseThreatHistory(block({ errors: ["nope", 7, {}, { source: "", message: "" }] }));
  assert.deepEqual(junk!.errors, []);
});

test("a truncated list is flagged, never silently cut", () => {
  const many = Array.from({ length: MAX_ROWS_PER_SOURCE + 40 }, (_, i) => ({ name: `Leak${i}`, date: "2020-01-01", matches: i }));
  const over = buildSource("leaklookup", { status: "ok", count: many.length, findings: many, truncated: true });
  assert.equal(over.rows.length, MAX_ROWS_PER_SOURCE);
  assert.equal(over.available, MAX_ROWS_PER_SOURCE + 40);
  assert.match(over.truncationNote, /showing the first 100 of 140/);
  assert.match(over.truncationNote, /truncated result set/);

  // Server-side truncation is surfaced even when the client cap did not cut.
  const under = buildSource("leaklookup", { status: "ok", count: 1, findings: [{ name: "A", date: "", matches: 1 }], truncated: true });
  assert.equal(under.rows.length, 1);
  assert.match(under.truncationNote, /truncated result set/);

  // Nothing cut means no note.
  const exact = buildSource("leaklookup", { status: "ok", count: 1, findings: [{ name: "A", date: "", matches: 1 }], truncated: false });
  assert.equal(exact.truncationNote, "");

  // `counts_truncated` is the same idea under another name elsewhere in the API.
  const alt = buildSource("leaklookup", { status: "ok", count: 1, findings: [{ name: "A", date: "", matches: 1 }], counts_truncated: true });
  assert.match(alt.truncationNote, /truncated result set/);
});

test("an OTX pulse name is previewed and its cut is shown", () => {
  const name = "A".repeat(PULSE_PREVIEW_CHARS * 4);
  const src = buildSource("otx", {
    status: "ok",
    count: 1,
    findings: [
      {
        pulse_id: "pulse-1",
        name,
        description: "a long community description",
        created: "2026-01-02",
        tlp: "green",
        author: "someone",
        malware_families: ["Emotet"],
      },
    ],
  });
  assert.equal(src.rows.length, 1);
  const cells = Object.fromEntries(src.rows[0].cells.map((c) => [c.label, c]));
  assert.equal(cells.Pulse.value.length, PULSE_PREVIEW_CHARS + 1);
  assert.ok(cells.Pulse.value.endsWith("…"));
  assert.equal(cells.Pulse.truncated, true);
  assert.equal(cells.Created.value, "2026-01-02");
  assert.equal(cells.TLP.value, "green");
  assert.equal(cells.Malware.value, "Emotet");
});

test("an OTX description is previewed harder than the pulse name", () => {
  // Descriptions are free-form community prose and routinely run long.
  const description = "D".repeat(PULSE_DESCRIPTION_CHARS * 3);
  const src = buildSource("otx", {
    status: "ok",
    count: 1,
    findings: [{ pulse_id: "p3", name: "short", description }],
  });
  const cell = src.rows[0].cells.find((c) => c.label === "Description")!;
  assert.equal(cell.value.length, PULSE_DESCRIPTION_CHARS + 1);
  assert.ok(cell.value.endsWith("…"));
  assert.equal(cell.truncated, true);
});

test("a TLP-restricted OTX pulse withholds its name and description", () => {
  // Amber/red pulses are non-public. The backend blanks them and sets this flag;
  // the card must never render a withheld value even if one leaks through.
  const src = buildSource("otx", {
    status: "ok",
    count: 1,
    findings: [
      {
        pulse_id: "pulse-2",
        name: "SECRET RED PULSE NAME",
        description: "SECRET RED DESCRIPTION",
        tlp: "red",
        tlp_restricted: true,
        created: "2026-01-02",
      },
    ],
  });
  const cells = Object.fromEntries(src.rows[0].cells.map((c) => [c.label, c.value]));
  assert.match(cells.Pulse, /withheld/i);
  assert.match(cells.Description, /withheld/i);
  assert.ok(!JSON.stringify(cells).includes("SECRET RED"));
  // The row is still useful: the pulse is counted and dated.
  assert.equal(cells.Created, "2026-01-02");
  assert.equal(cells.TLP, "red");
});

test("breach and banner strings come back as plain text, never as markup", () => {
  const payload = "<img src=x onerror=alert(1)><script>alert(2)</script>";
  const src = buildSource("leaklookup", {
    status: "ok",
    count: 1,
    findings: [{ name: payload, date: payload, matches: 1 }],
  });
  const cells = src.rows[0].cells;
  // The value is preserved as TEXT: React escapes it at render time. The helper
  // must not mangle it into markup and must not return anything but a string.
  for (const cell of cells) assert.equal(typeof cell.value, "string");
  assert.equal(cells[0].value, payload);
  assert.equal(cells[0].href ?? null, null);
  // Community pulse text takes the same path.
  const pulsed = buildSource("otx", {
    status: "ok",
    count: 1,
    findings: [{ pulse_id: "p", name: payload, description: payload }],
  });
  for (const cell of pulsed.rows[0].cells) {
    assert.equal(typeof cell.value, "string");
    assert.equal(cell.href ?? null, null);
  }
});

test("control characters and non-strings are neutralised by asPlainText", () => {
  assert.equal(asPlainText("Acme\x1b[31mLeak\x00"), "Acme [31mLeak");
  assert.equal(asPlainText("multi\nline\r\ntext"), "multi line text");
  assert.equal(asPlainText("<b>ok</b>"), "<b>ok</b>"); // returned verbatim as text
  assert.equal(asPlainText(undefined), "");
  assert.equal(asPlainText(null), "");
  assert.equal(asPlainText(7), "");
  assert.equal(asPlainText({ toString: () => "<img>" }), "");
});

test("clipText flags its own cut and never returns a non-string", () => {
  assert.deepEqual(clipText("short", 10), { text: "short", truncated: false });
  const cut = clipText("0123456789", 4);
  assert.equal(cut.text, "0123…");
  assert.equal(cut.truncated, true);
  assert.deepEqual(clipText(undefined, 4), { text: "", truncated: false });
});

test("data classes beyond the display cap say how many were dropped", () => {
  const many = Array.from({ length: 50 }, (_, i) => `class-${i}`); // server cap is 50
  const clipped = formatList(many);
  assert.ok(clipped.truncated);
  assert.match(clipped.text, /\+42 more$/);
  assert.deepEqual(formatList(["a", "b"]), { text: "a, b", truncated: false });
  assert.deepEqual(formatList("not a list"), { text: "", truncated: false });
});

test("only https URLs are linkable", () => {
  assert.equal(safeHttpsUrl("https://urlscan.io/screenshots/abc.png"), "https://urlscan.io/screenshots/abc.png");
  for (const bad of ["javascript:alert(1)", "data:text/html,<script>", "http://x", "https://", "", null, 3]) {
    assert.equal(safeHttpsUrl(bad), null, `must reject ${String(bad)}`);
  }
  const src = buildSource("urlscan", {
    status: "ok",
    count: 1,
    findings: [{ verdict: "malicious", task_uuid: "u-1", page_url: "javascript:alert(1)" }],
    screenshot_url: "javascript:alert(2)",
    window_days: 30,
    total: 1200,
  });
  assert.equal(src.screenshotUrl, null);
  assert.equal(src.rows[0].cells[1].href, null);
  assert.equal(src.rows[0].cells[1].value, "javascript:alert(1)");
  assert.equal(src.windowDays, 30);
  assert.equal(src.total, 1200);
});

test("summarize counts coverage, not just findings", () => {
  const sources = [
    buildSource("leaklookup", okSource()),
    buildSource("leaklookup", { status: "not_configured", note: "LEAKLOOKUP_API_KEY is not set." }),
    buildSource("urlscan", { status: "unavailable", note: "timeout" }),
  ];
  const s = summarize(sources);
  assert.equal(s.outcome, "incomplete");
  assert.equal(s.okSources, 1);
  assert.equal(s.failedSources, 1);
  assert.equal(s.unconfiguredSources, 1);
  assert.equal(s.findingCount, 0);
});

test("no source at all is incomplete, never a clean bill of health", () => {
  const s = summarize([]);
  assert.equal(s.outcome, "incomplete");
  assert.match(s.headline, /unknown/);
});

test("the card renders nothing for bad input and has no raw-HTML sink", () => {
  const src = readFileSync(
    join(here, "..", "app", "(dashboard)", "dashboard", "_components", "ThreatHistoryCard.tsx"),
    "utf8",
  );
  assert.ok(!src.includes("dangerouslySetInnerHTML"), "no raw HTML sink");
  assert.ok(!src.includes("javascript:"), "no scheme allowlist belongs in the component");
  assert.ok(src.includes("Skeleton"), "per-card loading skeleton");
  assert.ok(src.includes("if (!loading && !parsed) return null"), "unusable input renders nothing");
  // The empty-state copy is owned by the shape module; the card must render the
  // classified headline rather than hardcode its own "no records" wording.
  assert.ok(src.includes("{parsed.headline}"), "the card renders the classified headline");
  assert.ok(!src.includes("No threat records found"), "copy belongs in the shape module");
  assert.ok(!/style=\{\{/.test(src), "no inline style (theme comes from Tailwind)");
});