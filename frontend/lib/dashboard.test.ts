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

// Reversed 2026-10-14 (operator-approved redesign): 3D charts via three + @react-three/fiber + @react-three/drei are now allowed, data stays text/table a11y source, accessible labels, responsive, no pie-spam; chart.js retained because PortsChartInner/RiskTrendChartInner still import it.
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
  assert.ok(
    sidebar.includes("Where the data comes from"),
    "sidebar source block must read as provenance, not as a logo wall",
  );
  assert.ok(sidebar.includes("provenance"), "each source must say what it contributes");
  assert.ok(sidebar.includes("min-w-0") || shell.includes("min-w-0"), "min-w-0 flex fix required");
  assert.ok(shell.includes("sticky"), "header must be sticky");
  assert.ok(shell.includes("h-16"), "header must be h-16");
  for (const kept of ["TargetSearch", "ScanStatus", "PortsChart", "RiskTrendChart", "PortsTable", "VulnerabilitiesCard", "SubdomainsTable", "WhoisCard", "HistoryList"]) {
    assert.ok(page.includes(kept), `${kept} must be kept in the page grid`);
  }
  // Sections render in one ordered column: search → stats → charts → tables → history.
  // (JSX markers with "<" so import lines don't match.)
  const order = ["New scan", 'aria-label="scan stats"', "<PortsChart", "<PortsTable", "<VulnerabilitiesCard", "<SubdomainsTable", "<HistoryList"];
  let last = -1;
  for (const marker of order) {
    const at = page.indexOf(marker);
    assert.ok(at > last, `${marker} must come after the previous section`);
    last = at;
  }
});

test("dashboard cards share one header/content structure and locked chart heights", () => {
  const cards = ["PortsChart.tsx", "RiskTrendChart.tsx", "PortsTable.tsx", "VulnerabilitiesCard.tsx", "SubdomainsTable.tsx", "WhoisCard.tsx", "HistoryList.tsx"];
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

// The old contract read `dashboard data surfaces stay static — ambient motion is
// landing/auth only`, and it was reversed on 2026-10-12 (see DESIGN.md for the
// dated reversal note and the reason). What the reversal KEPT is the reason the
// lock existed in the first place, so the test now asserts that instead:
// the ambient layer is welcome, it is gated, it is decorative, and nothing that
// carries a value ever moves. The mechanical half of these two floors lives in
// lib/loop-contract.test.ts.
test("ambient layer is allowed, gated, and never moves a row", () => {
  const wash = readFileSync(join(here, "..", "app", "(dashboard)", "dashboard", "_components", "card-wash.tsx"), "utf8");
  const layer = readFileSync(join(here, "..", "app", "(dashboard)", "dashboard", "_components", "ambient-layer.tsx"), "utf8");
  const status = readFileSync(join(here, "..", "app", "(dashboard)", "dashboard", "_components", "ScanStatus.tsx"), "utf8");

  assert.ok(shell.includes("AmbientLayer"), "the dashboard shell renders an ambient layer");
  assert.ok(layer.includes('aria-hidden="true"'), "the ambient layer is decorative-only");
  assert.ok(layer.includes("pointer-events-none"), "the ambient layer cannot take a click");
  assert.ok(layer.includes("-z-10"), "the ambient layer sits behind the content, not on it");
  assert.ok(layer.includes("motion-safe:"), "every layered loop is motion-safe gated");

  // The wash is opacity-only, and it must never be a transform on content.
  assert.ok(wash.includes("motion-safe:animate-ambient-pulse"), "the card wash is the shared keyframe, gated");
  assert.ok(!wash.includes("animate-["), "the card wash introduces no bespoke keyframe");

  // A status loop reports state, so it is tied to polling — never to the badge
  // merely existing. A dot that keeps blinking after a scan has finished is the
  // dashboard claiming to be busy when it is not.
  assert.ok(status.includes("polling"), "the status badge knows whether a scan is polling");
  assert.ok(/polling &&/.test(status), "the live blip runs only while polling");

  // Floor #2, the half that cannot be gated: no data surface may move. The
  // tables and the history list are what an analyst reads line by line, so they
  // carry no loop at all — a row that reflows every frame cannot be read.
  for (const f of ["PortsTable.tsx", "SubdomainsTable.tsx", "WhoisCard.tsx", "VulnerabilitiesCard.tsx", "ThreatHistoryCard.tsx", "HistoryList.tsx"]) {
    const src = readFileSync(join(here, "..", "app", "(dashboard)", "dashboard", "_components", f), "utf8");
    assert.ok(!src.includes("animate-"), `${f}: a readable row must never move`);
  }
});

test("the dashboard shell keeps the sidebar and the content side by side", () => {
  // REGRESSION GUARD (2026-10-12). The ambient layer was added by wrapping the
  // sidebar + inset in a plain `<div className="relative isolate">`. That wrapper
  // sat between `SidebarProvider`'s flex container and the two things it arranges,
  // so neither of them was a flex item any more: the sidebar dropped to the
  // top-left, the content stacked underneath it in the same 240px column, and
  // the sticky `h-dvh` sidebar then stayed pinned across the content on scroll.
  //
  // The bug was shipped with every gate green — lint, tsc, 261/261 tests and a
  // production build all pass on a layout that is unusable, because none of them
  // render anything. Measured in Chrome against the production CSS: sidebar.x = 0,
  // main.x = 0, intrusion 240px; at 390px the content column collapsed to 91px.
  //
  // This test cannot measure layout, but it can pin the invariant that was
  // broken: between `<SidebarProvider>` and `<App1Sidebar` there must be no
  // block-level element, and the wrapper that does hold both must be a flex row.
  const open = shell.indexOf("<SidebarProvider>");
  const aside = shell.indexOf("<App1Sidebar");
  assert.ok(open !== -1 && aside > open, "the sidebar must render inside SidebarProvider");
  // Comments are stripped first: the guard's own explanation names the broken
  // markup, and a prose `<div>` is not a wrapper. (Same technique landing.test.ts
  // already uses when copy and code collide.) Indices are taken from the STRIPPED
  // source, so they must be found on it too — mixing the two silently slices the
  // wrong span.
  // The invariant that was broken is not "no wrapper" — the ambient layer needs
  // one. It is: THE wrapper that directly holds the sidebar and the inset must be
  // the flex row, and the sidebar must be its direct child (no second nesting).
  const code = shell.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const codeOpen = code.indexOf("<SidebarProvider>");
  const codeAside = code.indexOf("<App1Sidebar");
  assert.ok(codeOpen !== -1 && codeAside > codeOpen, "sidebar must render inside SidebarProvider after stripping comments");
  const wrapper = /<div className="([^"]*)"/.exec(code.slice(codeOpen, codeAside));
  assert.ok(wrapper, "the shell must have one wrapper holding both the sidebar and the content");
  assert.ok(
    /(^|\s)flex(\s|$)/.test(wrapper[1]),
    `the wrapper holding the sidebar and the content must be the flex row (got "${wrapper[1]}") — a plain block puts them in normal flow`,
  );
  const afterWrapper = code.slice(codeOpen + (wrapper.index ?? 0) + wrapper[0].length, codeAside);
  assert.ok(!/<div/.test(afterWrapper), "the sidebar must be a direct child of the flex row, with no nested wrapper between them");
  // The ambient layer is absolute, so it is out of flow and cannot steal a
  // flex-item slot from the sidebar or the inset.
  const layer = readFileSync(join(here, "..", "app", "(dashboard)", "dashboard", "_components", "ambient-layer.tsx"), "utf8");
  assert.ok(/absolute inset-0/.test(layer), "the ambient layer must be positioned, so it stays out of flex flow");
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

test("the scan detail surface exports what it shows, client-side", () => {
  // The export card is a verb on the scan the page is already showing, so it
  // comes after every data card rather than beside one of them.
  const order = ["<VulnerabilitiesCard", "<SubdomainsTable", "<HistoryList", "<ExportFindingsCard"];
  let last = -1;
  for (const marker of order) {
    const at = page.indexOf(marker);
    assert.ok(at > last, `${marker} must come after the previous section`);
    last = at;
  }

  const card = readFileSync(
    join(here, "..", "app", "(dashboard)", "dashboard", "_components", "ExportFindingsCard.tsx"),
    "utf8",
  );
  // Client-side only: no endpoint, no storage, and the PDF library is fetched
  // when the analyst asks for a PDF instead of being shipped in the first load.
  assert.ok(card.includes('await import("@/lib/export-pdf")'), "the PDF path must be dynamically imported");
  assert.ok(!/^import .*export-pdf/m.test(card), "jspdf must not be statically imported into the page bundle");
  assert.ok(!card.includes("fetch("), "the export must not make a request");
  assert.ok(card.includes("EXPORT_CAVEAT_SUMMARY"), "the card must promise the caveats the file carries");
  assert.ok(card.includes("variant=\"destructive\""), "a failed export must fail visibly");
  assert.ok(card.includes("Skeleton"), "the export card has a loading state");
  assert.ok(!card.includes("dangerouslySetInnerHTML"), "no raw HTML in the export card");

  // `jspdf` is reachable from exactly one module, and the JSON/Markdown
  // builders stay dependency-free.
  const pdf = readFileSync(join(here, "..", "lib", "export-pdf.ts"), "utf8");
  const findings = readFileSync(join(here, "..", "lib", "export-findings.ts"), "utf8");
  assert.ok(pdf.includes('await import("jspdf")'), "export-pdf.ts is the only module that loads jspdf");
  assert.ok(!/from\s+["']jspdf["']/.test(findings), "the JSON/Markdown builders must stay dependency-free");
  assert.ok(!/from\s+["']jspdf["']/.test(card), "the export card must not import jspdf itself");
});

test("a failed history or trend request never reads as an empty account", () => {
  // The most misleading bug in the copy audit: both routes caught a transport
  // failure and answered with an empty-but-well-formed collection and HTTP 502.
  // The history list rendered that as "No scans yet" and the trend chart
  // swallowed it entirely, so a dead backend looked exactly like a new user.
  const historyRoute = readFileSync(join(here, "..", "app", "api", "history", "route.ts"), "utf8");
  const trendRoute = readFileSync(join(here, "..", "app", "api", "trend", "[target]", "route.ts"), "utf8");

  for (const [name, src] of [["history", historyRoute], ["trend", trendRoute]] as const) {
    assert.ok(
      !src.includes("json({ items: []") && !src.includes("json({ points: []"),
      `${name} route must not fabricate an empty collection on failure`,
    );
    assert.ok(src.includes("messageForStatus(502)"), `${name} route must return a readable failure message`);
  }

  // The UI has to be able to tell the two apart, which means the trend chart
  // must stop discarding the rejection it used to catch and ignore.
  const trendInner = readFileSync(
    join(here, "..", "app", "(dashboard)", "dashboard", "_components", "RiskTrendChartInner.tsx"),
    "utf8",
  );
  assert.ok(trendInner.includes("setError"), "trend chart must track and render a load failure");
  assert.ok(!trendInner.includes(".catch(() => {})"), "trend chart must not swallow its own failure");
});
