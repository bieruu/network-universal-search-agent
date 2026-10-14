import test from "node:test";
import assert from "node:assert/strict";
import {
  BANNER_MAX_CHARS,
  ERROR_MAX_CHARS,
  LIST_MAX_ITEMS,
  buildExportReport,
  buildJsonExport,
  buildMarkdownExport,
  buildPdfLines,
  escapeMarkdown,
  exportFileName,
  fenceBlock,
} from "./export-findings.ts";
import { buildPdf } from "./export-pdf.ts";
import type { ScanResult } from "./api.ts";

/**
 * The export contract, pinned per format.
 *
 * Four rules are checked here rather than trusted, because each one has a
 * failure mode that looks like success:
 *
 *  1. A silent cap. A list cut at 500 rows with no note reads as the whole
 *     result, so `buildExportReport` has to disclose every cut it makes.
 *  2. A dropped `errors[]`. A source that failed and is then omitted from the
 *     file turns "we could not check" into "there is nothing there".
 *  3. An unescaped banner. Banners are attacker-written; a markdown fence that
 *     the content can close lets a banner add structure to the report.
 *  4. A caveat that stayed on the screen. The file must say the same things the
 *     dashboard says, or the analyst is reading a different document.
 */

const NOW = new Date("2026-10-14T12:00:00.000Z");
const SCAN_ID = "0f1e2d3c-4b5a-6978-87a6-b5c4d3e2f1a0";

function scan(over: Partial<ScanResult> = {}): ScanResult {
  return {
    scan_id: SCAN_ID,
    target: "example.com",
    status: "completed",
    risk_score: 37,
    results: {},
    errors: [],
    ...over,
  };
}

/** Active (far-future) and expired (long past) dates, so the fixed `now` the
 *  classification uses cannot make these flip. */
const FUTURE = "2099-01-01T00:00:00Z";
const PAST = "2001-01-01T00:00:00Z";

const HOSTILE_BANNER = [
  "SSH-2.0-OpenSSH_8.9",
  "```",
  "# Heading the banner wrote",
  "[click me](javascript:alert(1))",
  "<script>alert(1)</script>",
  "\u0000nul\u0007bell\u200bzwsp\u202ebidi",
  "| table | break |",
  "***bold*** _under_",
].join("\n");

/* ------------------------------------------------------------------ *
 * 1. Plain text: banners cut, controls stripped, no markup
 * ------------------------------------------------------------------ */

test("a long banner is cut at the banner cap and says so", () => {
  const banner = "A".repeat(BANNER_MAX_CHARS + 4096);
  const s = scan({
    results: { shodan: { ip: "203.0.113.9", services: [{ port: 443, product: "nginx", banner }] } },
  });
  const report = buildExportReport(s, NOW);

  assert.equal(report.ports?.services[0].banner.text.length, BANNER_MAX_CHARS);
  assert.equal(report.ports?.services[0].banner.truncated, true);

  const md = buildMarkdownExport(s, NOW);
  assert.ok(md.includes("cut short at 2,048 characters"), "the markdown must disclose the cut");

  const lines = buildPdfLines(s, NOW).join("\n");
  assert.ok(lines.includes("(cut short at 2048 characters)"), "the pdf must disclose the cut");

  const json = JSON.parse(buildJsonExport(s, NOW));
  assert.equal(json.ports.services[0].banner.text.length, BANNER_MAX_CHARS);
  assert.equal(json.ports.services[0].banner.truncated, true);
});

test("a short banner is not flagged as truncated", () => {
  const s = scan({ results: { shodan: { services: [{ port: 22, banner: "SSH-2.0-OpenSSH_9.6" }] } } });
  const row = buildExportReport(s, NOW).ports?.services[0];
  assert.equal(row?.banner.text, "SSH-2.0-OpenSSH_9.6");
  assert.equal(row?.banner.truncated, false);
  assert.ok(!buildMarkdownExport(s, NOW).includes("cut short"));
});

test("control and zero-width characters never reach any format", () => {
  const s = scan({ results: { shodan: { services: [{ port: 22, banner: HOSTILE_BANNER }] } } });
  for (const [name, text] of [
    ["markdown", buildMarkdownExport(s, NOW)],
    ["pdf", buildPdfLines(s, NOW).join("\n")],
    ["json", buildJsonExport(s, NOW)],
  ] as const) {
    for (const bad of ["\u0000", "\u0007", "\u001b", "\u007f", "\u200b", "\u202e", "\ufeff"]) {
      assert.ok(!text.includes(bad), `${name} must not carry ${JSON.stringify(bad)}`);
    }
  }
});

test("a banner stays inside a fence it cannot close, and nothing else is unescaped", () => {
  const s = scan({
    // Every one of these strings comes from outside the product: the target the
    // user typed, a provider's error text, and a service's own product string.
    target: "[x](javascript:alert(1)) # heading",
    results: { shodan: { services: [{ port: 22, product: "*[boom](javascript:alert(1))*", banner: HOSTILE_BANNER }] } },
    errors: [{ source: "shodan", message: "<b>timeout</b> | _after_ 12s" }],
  });
  const md = buildMarkdownExport(s, NOW);

  // The banner is a fenced block whose fence is longer than any backtick run in
  // it, so its ```, its heading and its link are inert content.
  assert.ok(md.includes("````"), "the fence must out-measure the content's longest backtick run");

  // Every OTHER external string is escaped, so it cannot become structure.
  assert.ok(!md.includes("[x](javascript:alert(1))"), `a hostile target must not render as a link:\n${md}`);
  assert.ok(md.includes("\\[x\\]\\(javascript:alert\\(1\\)\\)"), md);
  assert.ok(md.includes("\\# heading"), md);
  assert.ok(md.includes("\\*\\[boom\\]\\(javascript:alert\\(1\\)\\)\\*"), "a hostile product string must be escaped");
  assert.ok(!md.includes("<b>timeout</b>"), `a provider error must be escaped:\n${md}`);
  assert.ok(md.includes("\\<b\\>timeout\\</b\\>"), md);
  assert.ok(md.includes("\\| \\_after\\_ 12s"), md);

  // The JSON is a data format: the values are plain text (control characters
  // stripped) and the document round-trips, so a consumer reads the very same
  // strings the markdown escaped. A JSON string has no markup sink of its own.
  const json = JSON.parse(buildJsonExport(s, NOW));
  assert.equal(json.sourceErrors[0].message.text, "<b>timeout</b> | _after_ 12s");
  assert.equal(json.ports.services[0].product, "*[boom](javascript:alert(1))*");
  assert.equal(json.target, "[x](javascript:alert(1)) # heading");
  for (const bad of ["\u0000", "\u0007", "\u200b", "\u202e"]) {
    assert.ok(!buildJsonExport(s, NOW).includes(bad), `json must not carry ${JSON.stringify(bad)}`);
  }
});

test("the markdown fence is longer than any backtick run in the content", () => {
  assert.equal(fenceBlock("no backticks").split("\n")[0], "```");
  assert.equal(fenceBlock("```\ncode\n```").split("\n")[0], "````");
  assert.equal(fenceBlock("`````\ncode\n`````").split("\n")[0], "``````");

  // The hostile banner carries a triple backtick run, so the block around it
  // must be at least four. A three-tick fence here would let the banner close
  // the block and write headings into the report.
  const s = scan({ results: { shodan: { services: [{ port: 22, banner: HOSTILE_BANNER }] } } });
  const md = buildMarkdownExport(s, NOW);
  assert.ok(md.includes("````"), `expected a four-tick fence, got:\n${md}`);
  const fenceLines = md.split("\n").filter((l) => /^`{4,}$/.test(l));
  assert.equal(fenceLines.length % 2, 0, "every opened fence must be closed");
});test("escapeMarkdown escapes every markdown punctuation character", () => {
  assert.equal(escapeMarkdown("*bold*"), "\\*bold\\*");
  assert.equal(escapeMarkdown("a_b"), "a\\_b");
  assert.equal(escapeMarkdown("1. item"), "1\\. item");
  assert.equal(escapeMarkdown("C:\\path"), "C:\\\\path");
  assert.equal(escapeMarkdown("<b>"), "\\<b\\>");
});

/* ------------------------------------------------------------------ *
 * 2. Lists are capped, and the cap is disclosed
 * ------------------------------------------------------------------ */

function manySubdomains(n: number, after = FUTURE) {
  return Array.from({ length: n }, (_, i) => ({
    subdomain: `a${i}.example.com`,
    issuer: "Test CA",
    not_before: "2026-01-01T00:00:00Z",
    not_after: after,
  }));
}

test("a subdomain list over the cap keeps 500 rows and reports the rest", () => {
  const s = scan({ results: { crtsh: { domain: "example.com", subdomains: manySubdomains(LIST_MAX_ITEMS + 7) } } });
  const report = buildExportReport(s, NOW);
  assert.equal(report.subdomains?.rows.length, LIST_MAX_ITEMS);
  assert.equal(report.subdomains?.hidden, 7);
  assert.equal(report.subdomains?.unique, LIST_MAX_ITEMS + 7);

  const note = report.subdomains?.notes.find((n) => n.includes("not in this file"));
  assert.ok(note, "the capped list must carry a note");
  assert.ok(note?.includes("7 more names are not in this file"), note);
  assert.ok(buildMarkdownExport(s, NOW).includes("7 more names are not in this file"), "markdown must say it too");
  assert.ok(buildPdfLines(s, NOW).join("\n").includes("7 more names are not in this file"), "pdf must say it too");
});

test("a service list over the cap keeps 500 rows and reports the rest", () => {
  const services = Array.from({ length: LIST_MAX_ITEMS + 3 }, (_, i) => ({ port: 1000 + i }));
  const s = scan({ results: { shodan: { services } } });
  const report = buildExportReport(s, NOW);
  assert.equal(report.ports?.services.length, LIST_MAX_ITEMS);
  assert.equal(report.ports?.hidden, 3);
  assert.ok(buildMarkdownExport(s, NOW).includes("3 more services are not in this file"));
});

test("a list under the cap says nothing about being cut", () => {
  const s = scan({ results: { crtsh: { subdomains: manySubdomains(3) } } });
  const report = buildExportReport(s, NOW);
  assert.equal(report.subdomains?.hidden, 0);
  assert.ok(!report.subdomains?.notes.some((n) => n.includes("not in this file")));
  assert.ok(!buildMarkdownExport(s, NOW).includes("not in this file"));
});

/* ------------------------------------------------------------------ *
 * 3. errors[] travels with the file
 * ------------------------------------------------------------------ */

test("failed sources are listed in the report, never dropped", () => {
  const s = scan({
    status: "partial",
    errors: [
      { source: "shodan", message: "timeout after 12s" },
      { source: "crtsh", message: "TLS handshake failed" },
    ],
  });
  const report = buildExportReport(s, NOW);
  assert.equal(report.sourceErrors.length, 2);
  assert.equal(report.everySourceAnswered, false);
  assert.equal(report.sourceErrors[0].source, "shodan");
  assert.equal(report.sourceErrors[0].message.text, "timeout after 12s");
  assert.ok(
    report.caveats.some((c) => c.includes("2 sources did not answer")),
    "the caveat block must say the report is incomplete",
  );

  const json = JSON.parse(buildJsonExport(s, NOW));
  assert.deepEqual(
    json.sourceErrors.map((e: { source: string }) => e.source),
    ["shodan", "crtsh"],
  );
  const md = buildMarkdownExport(s, NOW);
  assert.ok(md.includes("`shodan`"), md);
  assert.ok(md.includes("timeout after 12s"));
  assert.ok(md.includes("TLS handshake failed"));

  const lines = buildPdfLines(s, NOW).join("\n");
  assert.ok(lines.includes("- shodan: timeout after 12s"), lines);
  assert.ok(lines.includes("- crtsh: TLS handshake failed"));
});

test("an over-long provider error message is cut and flagged", () => {
  const s = scan({ errors: [{ source: "nvd", message: "E".repeat(ERROR_MAX_CHARS + 900) }] });
  const report = buildExportReport(s, NOW);
  assert.equal(report.sourceErrors[0].message.text.length, ERROR_MAX_CHARS);
  assert.equal(report.sourceErrors[0].message.truncated, true);
  assert.ok(buildMarkdownExport(s, NOW).includes("cut short at 500 characters"));
});

test("a scan where every source answered says so", () => {
  const report = buildExportReport(scan(), NOW);
  assert.equal(report.sourceErrors.length, 0);
  assert.equal(report.everySourceAnswered, true);
  assert.ok(buildMarkdownExport(scan(), NOW).includes("Every source answered"));
});

/* ------------------------------------------------------------------ *
 * 4. The caveats travel with the data
 * ------------------------------------------------------------------ */

test("every format carries the two headline caveats", () => {
  const s = scan();
  for (const [name, text] of [
    ["markdown", buildMarkdownExport(s, NOW)],
    ["pdf", buildPdfLines(s, NOW).join("\n")],
    ["json", buildJsonExport(s, NOW)],
  ] as const) {
    assert.ok(text.includes("not proof the target is safe"), `${name}: no_match is not proof of safety`);
    assert.ok(text.includes("Missing data means unknown, not zero"), `${name}: missing data is not zero`);
  }
});

test("an NVD no_match is spelled out as a non-result, not as a clean sweep", () => {
  const s = scan({ results: { nvd: { status: "no_match", cve_rows: [] } } });
  const md = buildMarkdownExport(s, NOW);
  assert.ok(md.includes("That is not proof the host is safe"), md);
  assert.ok(buildPdfLines(s, NOW).join("\n").includes("That is not proof the host is safe"));
});

test("an absent source reads as unknown, never as none", () => {
  const s = scan();
  const md = buildMarkdownExport(s, NOW);
  assert.ok(md.includes("No names were returned by the certificate log. That is not the same as there being none."));
  assert.ok(md.includes("This target was not checked against the vulnerability catalogue. That is unknown, not none."));
  assert.ok(md.includes("No registration record was returned for this target."));
  const json = JSON.parse(buildJsonExport(s, NOW));
  assert.equal(json.subdomains.unique, 0);
  assert.equal(json.vulnerabilities, null);
  assert.equal(json.whois, null);
});

test("a cleansed subdomain list carries the dedup and expiry counts", () => {
  const s = scan({
    results: {
      crtsh: {
        subdomains: [
          { subdomain: "a.example.com", issuer: "CA", not_before: "2026-01-01T00:00:00Z", not_after: FUTURE },
          { subdomain: "a.example.com", issuer: "CA", not_before: "2026-01-01T00:00:00Z", not_after: FUTURE },
          { subdomain: "old.example.com", issuer: "CA", not_before: "2020-01-01T00:00:00Z", not_after: PAST },
          { subdomain: "???.example.com" },
        ],
      },
    },
  });
  const report = buildExportReport(s, NOW);
  assert.equal(report.subdomains?.reported, 4);
  assert.equal(report.subdomains?.unique, 3);
  assert.equal(report.subdomains?.duplicatesMerged, 1);
  assert.equal(report.subdomains?.active, 1);
  assert.equal(report.subdomains?.expired, 1);
  assert.equal(report.subdomains?.unknown, 1);

  const note = report.subdomains?.notes[0] ?? "";
  assert.ok(note.includes("1 duplicate entry"), note);
  assert.ok(note.includes("1 name carries a certificate that has already expired and is labelled, not hidden"), note);
  assert.ok(note.includes("1 name has validity dates that could not be read"), note);

  const md = buildMarkdownExport(s, NOW);
  assert.ok(md.includes("expired"), md);
  assert.ok(md.includes("validity unknown"), md);
});

/* ------------------------------------------------------------------ *
 * 5. PII and structure
 * ------------------------------------------------------------------ */

test("the export carries no scan identifier and no field the dashboard hides", () => {
  const s = scan({
    results: {
      shodan: { ip: "203.0.113.9", services: [{ port: 443 }] },
      // Host enrichment is not rendered by any card, so it must not be exported.
      host: { source: "internetdb", asn: "AS64500", asn_org: "Example Hosting" },
    },
  });
  for (const [name, text] of [
    ["markdown", buildMarkdownExport(s, NOW)],
    ["pdf", buildPdfLines(s, NOW).join("\n")],
    ["json", buildJsonExport(s, NOW)],
  ] as const) {
    assert.ok(!text.includes(SCAN_ID), `${name} must not carry the scan identifier`);
    assert.ok(!text.includes("Example Hosting"), `${name} must not carry un-displayed host enrichment`);
  }
  const json = JSON.parse(buildJsonExport(s, NOW));
  assert.ok(!("host" in json), "the un-rendered host block must not be exported");
  // The target IS displayed on the screen, so it stays.
  assert.equal(json.target, "example.com");
});

test("the json export is valid json with a trailing newline", () => {
  const text = buildJsonExport(scan(), NOW);
  assert.ok(text.endsWith("}\n"));
  const parsed = JSON.parse(text);
  assert.equal(parsed.generatedAt, NOW.toISOString());
  assert.equal(parsed.target, "example.com");
  assert.equal(parsed.riskScore, 37);
  assert.ok(Array.isArray(parsed.caveats) && parsed.caveats.length >= 2);
  assert.ok(parsed.provenance.every((p: string) => typeof p === "string" && p.length > 0));
});

test("a null scan still exports a report that says it has nothing", () => {
  const report = buildExportReport(null, NOW);
  assert.equal(report.target, "");
  assert.equal(report.subdomains, null);
  const md = buildMarkdownExport(null, NOW);
  assert.ok(md.includes("Findings export — no scan"));
  assert.ok(md.includes("not proof the target is safe"));
});

test("file names are safe, and the format decides the extension", () => {
  // `exportFileStem` drops the trailing Z of the ISO stamp, so the names end
  // "...000.json" — asserted exactly so a change in that stripping is visible.
  assert.equal(exportFileName("json", "example.com", NOW), "nusa-example-com-2026-10-14T12-00-00-000.json");
  assert.equal(exportFileName("markdown", "example.com", NOW), "nusa-example-com-2026-10-14T12-00-00-000.md");
  assert.equal(exportFileName("pdf", "example.com", NOW), "nusa-example-com-2026-10-14T12-00-00-000.pdf");
  // A hostile or empty target cannot escape the download directory.
  for (const target of ["../../etc/passwd", "", "..", "CON", "a".repeat(200)]) {
    const name = exportFileName("pdf", target, NOW);
    assert.ok(name.startsWith("nusa-") && name.endsWith(".pdf"), `unsafe file name: ${name}`);
    assert.ok(!name.includes("/") && !name.includes("\\") && !name.includes(".."), name);
    assert.ok(name.length <= 100, `file name too long: ${name.length}`);
  }
});

/* ------------------------------------------------------------------ *
 * 6. The PDF is a real PDF, paginated, built from plain lines
 * ------------------------------------------------------------------ */

test("buildPdf returns a paginated PDF blob", async () => {
  const s = scan({
    results: {
      crtsh: { subdomains: manySubdomains(LIST_MAX_ITEMS + 40) },
      shodan: { services: [{ port: 443, product: "nginx", banner: HOSTILE_BANNER }] },
    },
    errors: [{ source: "whois", message: "no answer" }],
  });
  const { blob, pages } = await buildPdf(s, NOW);

  assert.equal(blob.type, "application/pdf");
  assert.ok(blob.size > 0);
  assert.ok(pages > 1, "a report this long must paginate");

  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-", "the blob must be a real PDF");

  // A PDF has no HTML sink, but the text it carries is still the cleansed one.
  const lines = buildPdfLines(s, NOW).join("\n");
  assert.ok(!lines.includes("\u0000"), "the pdf text must be plain");
  assert.ok(lines.includes("- whois: no answer"), "the failed source must be in the pdf");
  assert.ok(lines.includes("500 of 540"), "the pdf must disclose the cap");
});
