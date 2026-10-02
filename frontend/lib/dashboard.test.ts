import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const shell = readFileSync(join(here, "..", "app", "(dashboard)", "dashboard", "_components", "app-shell.tsx"), "utf8");
const sidebar = readFileSync(join(here, "..", "components", "ui", "app-1-utils", "app-1-sidebar.tsx"), "utf8");
const data = readFileSync(join(here, "..", "components", "ui", "app-1-utils", "app-1-data.ts"), "utf8");
const page = readFileSync(join(here, "..", "app", "(dashboard)", "dashboard", "page.tsx"), "utf8");
const trend = readFileSync(join(here, "..", "app", "(dashboard)", "dashboard", "_components", "RiskTrendChart.tsx"), "utf8");

test("dashboard chart stays Chart.js, no recharts", () => {
  assert.ok(trend.includes("ssr: false"), "trend chart must stay ssr:false");
  for (const src of [shell, page, trend]) {
    assert.ok(!src.toLowerCase().includes("recharts"), "recharts is banned");
  }
  assert.ok(page.includes("RiskTrendChart"), "page must render RiskTrendChart in the charts grid");
});

test("dashboard stats come from the active scan, no fake deltas", () => {
  assert.ok(data.includes("scan.results.shodan"), "stats must read real scan data");
  for (const banned of ["from last month", "+2", "12%"]) {
    assert.ok(!page.includes(banned), `banned fake delta: ${banned}`);
    assert.ok(!data.includes(banned), `banned fake delta: ${banned}`);
  }
  assert.ok(page.includes("tabular-nums"), "numbers must be tabular mono");
});

test("dashboard shell is a pure shell; page owns the section order", () => {
  assert.ok(sidebar.includes("/dashboard"), "sidebar needs Dashboard nav");
  assert.ok(sidebar.includes("Sources"), "sidebar needs Sources section");
  assert.ok(sidebar.includes("min-w-0") || shell.includes("min-w-0"), "min-w-0 flex fix required");
  assert.ok(shell.includes("sticky"), "header must be sticky");
  assert.ok(shell.includes("h-16"), "header must be h-16");
  for (const kept of ["TargetSearch", "ScanStatus", "PortsChart", "RiskTrendChart", "PortsTable", "SubdomainsTable", "WhoisCard", "HistoryList"]) {
    assert.ok(page.includes(kept), `${kept} must be kept in the page grid`);
  }
  // Sections render in one ordered column: search → stats → charts → tables → history.
  // (JSX markers with "<" so import lines don't match.)
  const order = ["New scan", 'aria-label="scan stats"', "<PortsChart", "<PortsTable", "<SubdomainsTable", "<HistoryList"];
  let last = -1;
  for (const marker of order) {
    const at = page.indexOf(marker);
    assert.ok(at > last, `${marker} must come after the previous section`);
    last = at;
  }
});

test("dashboard cards share one header/content structure and locked chart heights", () => {
  const cards = ["PortsChart.tsx", "RiskTrendChart.tsx", "PortsTable.tsx", "SubdomainsTable.tsx", "WhoisCard.tsx", "HistoryList.tsx"];
  for (const f of cards) {
    const src = readFileSync(join(here, "..", "app", "(dashboard)", "dashboard", "_components", f), "utf8");
    assert.ok(src.includes("CardHeader"), `${f} must use CardHeader`);
    assert.ok(src.includes("CardContent"), `${f} must use CardContent`);
  }
  for (const f of ["PortsChartInner.tsx", "RiskTrendChartInner.tsx"]) {
    const src = readFileSync(join(here, "..", "app", "(dashboard)", "dashboard", "_components", f), "utf8");
    assert.ok(src.includes("h-[240px]"), `${f} must lock chart height`);
    assert.ok(src.includes("maintainAspectRatio: false"), `${f} must not stretch the page`);
  }
});

test("dashboard shell has no injection vectors or banned accents", () => {
  const named: Record<string, string> = { shell, sidebar, data, page };
  for (const name of Object.keys(named)) {
    const src = named[name];
    assert.ok(!src.includes("dangerouslySetInnerHTML"), `${name}: no raw HTML`);
    assert.ok(!src.includes("javascript:"), `${name}: no javascript: URLs`);
  }
  for (const banned of ["#3b82f6", "#5046e6", "from-blue", "to-purple"]) {
    assert.ok(!shell.includes(banned), `banned accent: ${banned}`);
  }
});

test("mobile sheet sidebar stays visible below md", () => {
  assert.ok(
    shell.includes("max-md:flex"),
    "sheet sidebar must override the base hidden class below md (plain cn() join cannot remove it)",
  );
});

test("button forwards ref for asChild triggers", () => {
  const button = readFileSync(join(here, "..", "components", "ui", "button.tsx"), "utf8");
  assert.ok(button.includes("forwardRef"), "Button must forward ref so Radix asChild triggers work");
});

test("status colors use theme-aware tokens, table borders pair light/dark", () => {
  const status = readFileSync(join(here, "..", "app", "(dashboard)", "dashboard", "_components", "ScanStatus.tsx"), "utf8");
  const target = readFileSync(join(here, "..", "app", "(dashboard)", "dashboard", "_components", "TargetSearch.tsx"), "utf8");
  const table = readFileSync(join(here, "..", "components", "ui", "table.tsx"), "utf8");
  assert.ok(status.includes("text-warning"), "partial errors use the warning token");
  assert.ok(!status.includes("amber-300"), "no bare amber that fails light mode");
  assert.ok(target.includes("text-danger"), "form errors use the danger token");
  assert.ok(!target.includes("red-400"), "no bare red that fails light mode");
  assert.ok(table.includes("dark:border-neutral-800"), "table rows pair light/dark borders");
});

test("charts resolve colors from the global tokens", () => {
  for (const f of ["PortsChartInner.tsx", "RiskTrendChartInner.tsx"]) {
    const src = readFileSync(join(here, "..", "app", "(dashboard)", "dashboard", "_components", f), "utf8");
    assert.ok(src.includes("chartPalette"), `${f} must use token-driven chart colors`);
    assert.ok(!src.includes("#"), `${f} must not hardcode hex colors`);
  }
});
