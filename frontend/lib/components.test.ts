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
  assert.match(sources["PortsTable.tsx"], /No open ports were found/);
  assert.match(sources["SubdomainsTable.tsx"], /No subdomains found/);
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
    sources["WhoisCard.tsx"].includes("the registry hides this to protect the registrant"),
    "a withheld WHOIS field must explain itself, not read as a raw 'redacted'",
  );
});

test("SubdomainsTable caps rendered rows and says how many it hid", () => {
  const src = sources["SubdomainsTable.tsx"];
  assert.ok(src.includes("slice(0, MAX_ROWS)"), "row cap required");
  assert.ok(src.includes("Showing the first"), "a silent row cap is a lie about coverage");
});

test("loading skeletons present on data cards", () => {
  for (const f of ["PortsTable.tsx", "SubdomainsTable.tsx", "WhoisCard.tsx", "VulnerabilitiesCard.tsx"]) {
    assert.ok(sources[f].includes("Skeleton"), `${f} must render a Skeleton while loading`);
  }
});

test("vulnerabilities card states never claim zero or safety", () => {
  const src = sources["VulnerabilitiesCard.tsx"];
  assert.ok(src.includes("not proof") || src.includes("never proof"), "must warn that no_match is not proof of safety");
  assert.ok(src.includes("unknown, not zero"), "must warn that missing data is not zero");
  assert.ok(src.includes("cveTierView"), "must map the evidence tier through cveTierView, not render the raw enum");
  assert.ok(src.includes("nvdStatusView"), "must map the NVD status through nvdStatusView, not render the raw enum");
  assert.ok(!src.includes("insufficient_evidence"), "the raw snake_case NVD enum must never be rendered");
  // The tier glossary and the keyword-leads caveat are analyst safety
  // information. They moved into <details>, not off the card.
  assert.ok(src.includes("<details"), "the label glossary must stay on the card");
  assert.ok(src.includes("Confirmed match"), "tier distinctions must survive the rewrite");
  assert.ok(src.includes("Rejected by the publisher"), "tier distinctions must survive the rewrite");
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
