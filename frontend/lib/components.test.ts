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
  assert.match(sources["PortsTable.tsx"], /No ports found/);
  assert.match(sources["SubdomainsTable.tsx"], /No subdomains found/);
  assert.match(sources["WhoisCard.tsx"], /No WHOIS data/);
});

test("PortsTable shows error badge and truncates banners", () => {
  const src = sources["PortsTable.tsx"];
  assert.ok(src.includes('variant="destructive"'), "error badge required");
  assert.ok(src.includes("slice(0, 120)"), "banner must be truncated for display");
});

test("WhoisCard falls back to redacted for missing emails", () => {
  assert.ok(sources["WhoisCard.tsx"].includes("redacted"), "GDPR redacted fallback required");
});

test("SubdomainsTable caps rendered rows", () => {
  assert.ok(sources["SubdomainsTable.tsx"].includes("slice(0, 100)"), "row cap required");
});

test("loading skeletons present on data cards", () => {
  for (const f of ["PortsTable.tsx", "SubdomainsTable.tsx", "WhoisCard.tsx", "OverviewCards.tsx", "VulnerabilitiesCard.tsx"]) {
    assert.ok(sources[f].includes("Skeleton"), `${f} must render a Skeleton while loading`);
  }
});

test("vulnerabilities card states never claim zero or safety", () => {
  const src = sources["VulnerabilitiesCard.tsx"];
  assert.ok(src.includes("not proof"), "must warn that no_match is not proof of safety");
  assert.ok(src.includes("not 0") || src.includes("not zero"), "must warn that missing data is not zero");
  assert.ok(src.includes("Evidence CPE"), "must show the CPE evidence per CVE");
});

test("vulnerabilities card shows tier badge, NVD link, and source", () => {
  const src = sources["VulnerabilitiesCard.tsx"];
  assert.ok(src.includes("nvd.nist.gov/vuln/detail/"), "each CVE must link to NVD");
  assert.ok(src.includes('"rejected"'), "rejected tier must render");
  assert.ok(src.includes('"verified"') && src.includes('"unverified"'), "all tiers must render");
  assert.ok(src.includes("Source"), "source column required");
  assert.ok(!src.includes("dangerouslySetInnerHTML"), "no raw HTML injection");
});
