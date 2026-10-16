import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `/demo` — the pre-scanned demo target (TODO item Public/Guest Demo Sandbox,
 * part a). The route shows a full report to a signed-out visitor with ZERO
 * backend requests, so the three properties that make it acceptable are
 * pinned here as source contracts, in the style of `landing.test.ts`:
 *
 *   1. the page announces itself as a simulation (notice + caption, in
 *      metadata and on screen),
 *   2. nothing on the route can reach the network,
 *   3. every figure comes from the shared fixtures — the illustrative detail
 *      is marked, and no measurement (score, date, CVE) is invented.
 *
 * The fixture builder itself is imported at RUNTIME (node type-stripping), so
 * "the reports really are derived from DEMO_SCANS" is checked against data,
 * not against the spelling of the source.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (...parts: string[]) => readFileSync(join(here, "..", ...parts), "utf8");

const page = read("app", "demo", "page.tsx");
const view = read("app", "demo", "demo-report-view.tsx");
const fixture = read("app", "demo", "demo-report.ts");
const hero = read("app", "_components", "landing", "Hero.tsx");
const cta = read("app", "_components", "landing", "CtaFooter.tsx");
const middleware = read("middleware.ts");
const demoSources: Array<[string, string]> = [
  ["app/demo/page.tsx", page],
  ["app/demo/demo-report-view.tsx", view],
  ["app/demo/demo-report.ts", fixture],
];
// JSX wraps prose across lines, so sentence assertions run against a
// single-line copy — otherwise every long sentence fails at the fold.
const flatView = view.replace(/\s+/g, " ");

/** Prose comments often QUOTE the very tokens these tests look for. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the demo page announces itself as a simulation", () => {
  // On screen: the shared notice (imported, never re-worded) plus the caption
  // declared once and printed in three places — heading, under the switcher,
  // and in the footer strip.
  assert.ok(
    view.includes('from "../_components/landing/playground-demo"'),
    "the notice must come from the shared playground demo, not a copy",
  );
  assert.ok(view.includes("DEMO_NOTICE"), "the shared notice must print on the page");
  assert.ok(
    view.includes('const DEMO_CAPTION = "Demo — simulated output"'),
    "the caption carries the exact wording the playground uses",
  );
  const captions = view.match(/\{DEMO_CAPTION\}/g) ?? [];
  assert.ok(captions.length >= 3, `the caption must print in at least three places, found ${captions.length}`);
  // In metadata: the title and description promise simulation, not a scan.
  assert.ok(page.includes('"Demo report — simulated output, no live scan"'), "title must say simulated, no live scan");
  assert.ok(page.includes("no source is contacted and no request is made"), "description must deny any request");
  assert.ok(page.includes("robots: { index: false"), "a fabricated report must not be indexed");
  // The honesty lines the brief requires: no_match is not proof of safety,
  // and failed sources leave gaps rather than answers.
  assert.ok(flatView.includes("not proof the target is safe"), "no_match must be called out as not proof");
  assert.ok(flatView.includes("not checked, not confirmed absent"), "partial failure must keep the gap wording");
});

test("the demo route makes zero backend requests and reads no session", () => {
  for (const [name, src] of demoSources.map(([n, s]) => [n, code(s)] as [string, string])) {
    assert.ok(!/\bfetch\s*\(/.test(src), `${name}: no fetch`);
    assert.ok(!src.includes("/api/"), `${name}: no API path`);
    assert.ok(!src.includes("BACKEND_URL"), `${name}: no backend URL`);
    assert.ok(!/\bstartScan|\bpollScan|\bfetchScan|\bfetchHistory\b/.test(src), `${name}: no scan client`);
    assert.ok(!/\bgetSession\b|\bcookies\s*\(|\bheaders\s*\(/.test(src), `${name}: no session read`);
  }
  // The middleware is CSP-only since the guest reversal; if a redirect ever
  // comes back, a signed-out visitor could lose the demo route silently.
  assert.ok(!middleware.includes("NextResponse.redirect"), "middleware must not redirect /demo");
  // The view is client only to switch module data — no JS-driven motion, so
  // no reduced-motion gate is needed and no hydration can depend on it.
  assert.ok(!view.includes('from "motion/react"'), "the demo view animates nothing from JS");
});

test("demo reports are assembled from the shared fixtures at runtime", async () => {
  const { DEMO_REPORTS, demoStats } = await import("../app/demo/demo-report.ts");
  const { DEMO_SCANS, sampleMetrics } = await import(
    "../app/_components/landing/playground-samples.ts"
  );
  assert.equal(DEMO_REPORTS.length, DEMO_SCANS.length, "one report per shared sample");
  for (let i = 0; i < DEMO_SCANS.length; i++) {
    const report = DEMO_REPORTS[i];
    const sample = DEMO_SCANS[i];
    assert.equal(report.target, sample.target, "targets keep the fixture order");
    assert.equal(report.command, sample.command, "the command line is the fixture's own");
    assert.deepEqual(report.output, sample.output, "the four lines travel verbatim");
    assert.equal(report.lines.length, sample.output.length, "every line is split, none dropped");
    for (let j = 0; j < report.lines.length; j++) {
      const line = report.lines[j];
      assert.ok(sample.output[j].startsWith(line.source), "the split keeps the source id");
      assert.ok(sample.output[j].includes(line.says), "the split keeps the text");
    }
    assert.deepEqual(report.metrics, sampleMetrics(sample), "counts come from the shared parser");
    // The stats strip is a rendering of those counts — no second number set.
    const stats = demoStats(report);
    assert.equal(
      stats[0].value,
      String(sampleMetrics(sample).ports ?? "—"),
      "ports stat equals the fixture line",
    );
    assert.equal(
      stats[1].value,
      String(sampleMetrics(sample).certNames ?? "—"),
      "names stat equals the fixture line",
    );
  }
});

test("illustrative detail is marked and invents no measurements", async () => {
  const { DEMO_REPORTS, nameListNote } = await import("../app/demo/demo-report.ts");
  const json = JSON.stringify(DEMO_REPORTS);
  // No plausible-looking measurements may exist anywhere in the fixtures.
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(json), "no invented dates");
  assert.ok(!json.includes("CVE-"), "no invented CVE ids");
  assert.ok(!json.includes("risk_score") && !json.includes("cvss"), "no invented scores");
  assert.ok(!/\d+\.\d+/.test(json), "no version-shaped decimals");
  // Illustrative hostnames only ever sit under their own reserved zone.
  for (const report of DEMO_REPORTS) {
    const zone = report.target.split(".").slice(1).join(".");
    for (const name of report.names) {
      assert.ok(name.endsWith(`.${zone}`), `${name} must stay under the reserved ${zone}`);
    }
    if (report.nameserverCount != null) {
      assert.equal(report.nameServers.length, report.nameserverCount, "one hostname per counted slot");
    } else {
      assert.equal(report.nameServers.length, 0, "no hostnames when the fixture counts none");
    }
  }
  // The view marks the illustrative cards and states the truncation honestly.
  assert.ok(flatView.includes("Illustrative — demo data"), "the names card carries its mark");
  const acme = DEMO_REPORTS.find((r) => r.target === "api.acme.co");
  assert.ok(acme, "the deeper sample must exist");
  assert.ok(nameListNote(acme).includes("4 of the 12"), "the list must say how much it hides");
});

test("the scripted source failure renders the partial state", async () => {
  const { DEMO_REPORTS } = await import("../app/demo/demo-report.ts");
  const failed = DEMO_REPORTS.filter((r) => r.errors.length > 0);
  assert.equal(failed.length, 1, "exactly one target demonstrates partial failure");
  assert.equal(failed[0].target, "api.acme.co", "the failure is scripted where the fixture lines cannot contradict it");
  assert.equal(failed[0].errors[0].source, "nvd", "only a source the fixture never lists is scripted as failed");
  assert.ok(/simulated/i.test(failed[0].errors[0].message), "the message must say simulated in words");
  for (const report of DEMO_REPORTS) {
    if (report === failed[0]) continue;
    assert.equal(report.errors.length, 0, "the other reports stay clean");
  }
  // The view renders errors[] the way the dashboard does: count sentence,
  // source badges, the provider message, and the gap-not-answer warning.
  assert.ok(view.includes("sourceFailureCount"), "the shared failure sentence must be used");
  assert.ok(view.includes('aria-label="sources that did not answer"'), "failed sources are listed to AT");
  assert.ok(view.includes("demoSourceLabel"), "sources are named in words, not raw ids");
  assert.ok(view.includes('variant="destructive"'), "the failure badge uses the destructive variant");
  assert.ok(view.includes("No source failure is scripted"), "the clean state says why it is clean");
});

test("every card keeps an honest empty state and a11y contract", () => {
  // Loading/error/empty per AGENTS.md §6 — here the "loading" state cannot
  // exist (nothing loads), so what must exist is the empty state for each
  // field the fixture lacks, plus a spoken name on the interactive parts.
  assert.ok(flatView.includes("Not in the demo fixture"), "missing dates say so");
  assert.ok(flatView.includes("invents no port numbers"), "the port table refuses to fabricate rows");
  assert.ok(flatView.includes("records none"), "a missing nameserver count is stated, not zeroed");
  assert.ok(flatView.includes("absence of data, not a clean result"), "an empty CVE list is not a pass");
  assert.ok(view.includes("aria-pressed"), "the switcher announces the selected target");
  assert.ok(view.includes('role="group"'), "the switcher is a named group");
  assert.ok(view.includes("aria-label"), "decorative and grouped surfaces stay labelled");
  // shadcn primitives only (AGENTS.md §6).
  for (const ui of ["card", "badge", "table", "button"]) {
    assert.ok(view.includes(`@/components/ui/${ui}`), `must use the shared ${ui} primitive`);
  }
  // Token colours only: no hex literal may appear on the route.
  for (const [name, src] of demoSources) {
    assert.ok(!/#[0-9a-fA-F]{3,8}/.test(src), `${name}: no colour literal`);
  }
  // Any looping class must carry the same motion-safe gate the loop contract
  // enforces repo-wide (the header monogram ring breathes like the nav's).
  const loop = /(?:^|[\s"'`])((?:motion-(?:safe|reduce):)?animate-(?:\[[^\]]*\]|[a-z0-9-]+))/g;
  for (const [name, src] of demoSources) {
    for (const m of src.matchAll(loop)) {
      assert.ok(
        m[1].startsWith("motion-safe:") || m[1].startsWith("motion-reduce:"),
        `${name}: ${m[1]} must be motion gated`,
      );
    }
  }
});

test("the landing links into the demo from the playground and the footer", () => {
  assert.ok(hero.includes('href="/demo"'), "the hero terminal links to the full demo report");
  assert.ok(hero.includes("Open the full demo report"), "the link names what it opens");
  assert.ok(cta.includes('href="/demo"'), "the footer links to the demo too");
  assert.ok(cta.includes("Demo report"), "the footer label stays short like its siblings");
  // Same intent, one label per intent — and the banned CTA variants stay out.
  for (const banned of ["Get started", "Try free", "Learn more", "Sign up"]) {
    assert.ok(!hero.includes(banned) && !cta.includes(banned), `banned CTA variant: ${banned}`);
  }
  // The playground's own contracts (notice, caption, fixture path) are owned
  // by landing.test.ts; what is asserted here is only that neither edit
  // removed the terminal from the hero.
  assert.ok(hero.includes("PlaygroundTerminal"), "the hero still renders the playground");
});
