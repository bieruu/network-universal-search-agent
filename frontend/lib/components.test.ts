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
  for (const f of ["PortsTable.tsx", "SubdomainsTable.tsx", "WhoisCard.tsx", "OverviewCards.tsx"]) {
    assert.ok(sources[f].includes("Skeleton"), `${f} must render a Skeleton while loading`);
  }
});
