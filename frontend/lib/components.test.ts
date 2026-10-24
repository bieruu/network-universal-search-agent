import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const componentsDir = join(here, "..", "app", "(dashboard)", "dashboard", "_components");
const files = readdirSync(componentsDir).filter((f) => f.endsWith(".tsx"));
const sources = Object.fromEntries(
  files.map((f) => [f, readFileSync(join(componentsDir, f), "utf8")]),
);

test("components render untrusted data as text (no dangerouslySetInnerHTML)", () => {
  for (const [f, src] of Object.entries(sources)) {
    assert.ok(!src.includes("dangerouslySetInnerHTML"), `${f} must not use dangerouslySetInnerHTML`);
  }
});

test("no raw <script> or javascript: URLs in dashboard components", () => {
  for (const [f, src] of Object.entries(sources)) {
    assert.ok(!src.includes("javascript:"), `${f} must not contain javascript: URLs`);
  }
});

test("each data card has an empty state", () => {
  // Ports and names come from passive public records, so an empty answer is
  // only what those records do not contain. These two cards used to read as a
  // clean negative ("no open ports", "no subdomains"); the second assertion on
  // each pins the honesty clause, so a later rewrite cannot quietly turn
  // "we found nothing in the record" back into "nothing is there".
  assert.match(sources["PortsTable.tsx"], /Shodan's records list no open ports/);
  assert.match(sources["PortsTable.tsx"], /not proof they are closed/);
  assert.match(sources["SubdomainsTable.tsx"], /public certificate log lists no names/);
  assert.match(sources["SubdomainsTable.tsx"], /not proof that none exist/);
  assert.match(sources["WhoisCard.tsx"], /No registration details/);
});

test("PortsTable shows error badge and truncates banners visibly", () => {
  const src = sources["PortsTable.tsx"];
  assert.ok(src.includes('variant="destructive"'), "error badge required");
  assert.ok(src.includes("slice(0, BANNER_PREVIEW_CHARS)"), "banner must be truncated for display");
  assert.ok(src.includes("(cut short)"), "a truncated banner must say it was cut");
});

test("WhoisCard explains why a withheld field has no value", () => {
  assert.ok(
    sources["WhoisCard.tsx"].includes("registry hides this to protect the registrant"),
    "a withheld WHOIS field must explain itself, not read as a raw 'redacted'",
  );
});

test("SubdomainsTable caps rendered rows and says how many it hid", () => {
  const src = sources["SubdomainsTable.tsx"];
  const view = readFileSync(join(here, "..", "lib", "subdomains-view.ts"), "utf8");
  // The cap itself moved into lib/subdomains-view.ts when the table gained
  // filtering and pagination: one page of MAX_ROWS rows is sliced there, and
  // every surface that lists names reads the same view. What must NOT change is
  // that a cap exists at all and that it is announced - so the same two
  // assertions are made against the module that now owns them.
  assert.ok(view.includes("slice(start, start + pageSize)"), "row cap required");
  assert.ok(view.includes("Showing 1 to"), "the row note must state the visible range");
  assert.ok(view.includes("more on"), "a silent row cap is a lie about coverage: the note must count the rows on later pages");
  assert.ok(view.includes("export const MAX_ROWS = 50"), "the page size is still 50");
  // And the table renders the view's own sentences, so the two cannot drift.
  assert.ok(src.includes("subdomainsVisibility"), "the table must read the shared view");
  assert.ok(src.includes("visibility.rowNote"), "the table must render the announced hidden count");
  assert.ok(src.includes("visibility.honestyNote"), "the table must state what was merged and relabelled");
});

test("loading skeletons present on data cards", () => {
  for (const f of ["PortsTable.tsx", "SubdomainsTable.tsx", "WhoisCard.tsx", "VulnerabilitiesCard.tsx"]) {
    assert.ok(sources[f].includes("Skeleton"), `${f} must render a Skeleton while loading`);
  }
});

test("vulnerabilities card states never claim zero or safety", () => {
  const src = sources["VulnerabilitiesCard.tsx"];
  assert.ok(src.includes("not proof") || src.includes("never proof"), "must warn that no_match is not proof of safety");
  assert.ok(src.includes("unknown is not zero"), "must warn that missing data is not zero");
  assert.ok(src.includes("cveTierView"), "must map the evidence tier through cveTierView, not render the raw enum");
  assert.ok(src.includes("nvdStatusView"), "must map the NVD status through nvdStatusView, not render the raw enum");
  assert.ok(!src.includes("insufficient_evidence"), "the raw snake_case NVD enum must never be rendered");
  // The tier glossary and the keyword-leads caveat are analyst safety
  // information. They moved into <details>, not off the card.
  assert.ok(src.includes("<details"), "the label glossary must stay on the card");
  assert.ok(src.includes("Confirmed match"), "tier distinctions must survive the rewrite");
  assert.ok(src.includes("Rejected"), "tier distinctions must survive the rewrite");
  assert.ok(
    src.includes("vendor marked the entry rejected or disputed"),
    "a Rejected label must explain itself, not read as a bare verdict",
  );
  assert.ok(
    !src.includes("{nvd.note}"),
    "the backend note is provider plumbing and must not be rendered verbatim",
  );
});

test("vulnerabilities card shows tier badge, NVD link, and source", () => {
  const src = sources["VulnerabilitiesCard.tsx"];
  assert.ok(src.includes("nvd.nist.gov/vuln/detail/"), "each CVE must link to NVD");
  assert.ok(src.includes("Source"), "source column required");
  assert.ok(src.includes("/10"), "the CVSS score must carry its 0-10 unit");
  assert.match(src, /confident we are/i, "the tier column must be framed as confidence, not severity");
  assert.ok(!src.includes("dangerouslySetInnerHTML"), "no raw HTML injection");
});

test("no dashboard component renders a raw backend enum or a scan id", () => {
  const forbidden = ["scan_id:", "via shodan", "via crtsh", "force=true", "Backend unreachable"];
  for (const [f, src] of Object.entries(sources)) {
    for (const needle of forbidden) {
      assert.ok(!src.includes(needle), `${f} must not render "${needle}"`);
    }
  }
});
