import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PHASE_SECONDS, phaseDelay, phaseDeclarations } from "./motion-phases.ts";

/**
 * The two floors of this project's motion, made mechanical.
 *
 * They were written down in README.md ("reduced-motion aware") and in
 * AGENTS.md §6, and then in DESIGN.md at length, and none of that stopped
 * anything: prose about a rule is a rule that survives exactly until the next
 * person adds a loop and does not read the section. This file is the rule.
 *
 * FLOOR 1 — every loop collapses under `prefers-reduced-motion`.
 *   Every `animate-*` in the frontend source must be `motion-safe:` gated, or
 *   the file must gate it in JS with `useReducedMotion()` (the only case where a
 *   class cannot work: JS-driven motion, where a class would look like a gate
 *   while doing nothing).
 *
 * FLOOR 2 — nothing readable ever moves.
 *   Only `transform` / `opacity` / `filter` may be animated. No `width`,
 *   `height`, `margin`, `padding`, `top`, `left`, `font-size` — nothing that
 *   reflows. Table rows, risk figures and banners hold still because a row that
 *   moves every frame is a row that cannot be read.
 *
 * FLOOR 3 (the one that keeps 1 and 2 from rotting) — one period table.
 *   `lib/motion-phases.ts` is the only place a duration or a delay may be
 *   invented, and `phaseDeclarations()` emits the CSS `--animate-*` lines that
 *   `globals.css` must carry. A stylesheet that drifts from the table is two
 *   sources of truth about the same loop.
 */

const here = dirname(fileURLToPath(import.meta.url));
const frontend = join(here, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === "out") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !entry.includes(".test.")) out.push(full);
  }
  return out;
}

const SOURCES = walk(frontend).map((full) => ({
  rel: relative(frontend, full).replaceAll("\\", "/"),
  src: readFileSync(full, "utf8"),
}));

test("floor 1: every looping class is motion-safe gated", () => {
  const ungated: string[] = [];
  for (const { rel, src } of SOURCES) {
    const matches = src.matchAll(/(?:^|[\s"'`])((?:motion-(?:safe|reduce):)?animate-(?:\[[^\]]*\]|[a-z0-9-]+))/g);
    for (const m of matches) {
      const token = m[1];
      if (token.startsWith("motion-safe:") || token.startsWith("motion-reduce:")) continue;
      ungated.push(`${rel}: ${token}`);
    }
  }
  assert.deepEqual(ungated, [], `ungated looping classes (${ungated.length}); gate them with motion-safe:`);
});

test("floor 1b: motion driven from JS is gated in JS, not with a class", () => {
  // A class cannot gate a value that is set from JS — `motion-safe:` would sit in
  // the className looking like a gate while the `motion.div` keeps animating. So
  // every file that drives motion itself must ask the system.
  const drivers = SOURCES.filter(({ src }) => /from "(?:motion|framer-motion)\/react"/.test(src));
  assert.ok(drivers.length >= 6, `expected the project's motion drivers, found ${drivers.length}`);
  for (const { rel, src } of drivers) {
    assert.ok(
      src.includes("useReducedMotion"),
      `${rel} animates from JS but never calls useReducedMotion() — a class gate would be theatre here`,
    );
  }
});

test("floor 2: no keyframe animates a layout property", () => {
  const css = readFileSync(join(frontend, "app", "globals.css"), "utf8");
  const blocks = css.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\n\s*\}/g);
  const found = [...blocks];
  assert.ok(found.length >= 8, `expected the project's keyframes, found ${found.length}`);
  // Only compositor-friendly properties. Anything absent from this list is
  // something that moves other content — the failure mode floor 2 exists for.
  const allowed = new Set(["transform", "opacity", "filter"]);
  for (const [, name, body] of found) {
    const props = [...body.matchAll(/([-a-z]+)\s*:/g)].map((m) => m[1]);
    for (const p of props) {
      assert.ok(allowed.has(p), `@keyframes ${name} animates "${p}" — only transform/opacity/filter may move`);
    }
  }
});

test("floor 2b: no source asks a keyframe to move layout, even via an arbitrary value", () => {
  const banned = /\banimate-\[(?:[^_\]]*_)*(?:width|height|margin|padding|top|left|right|bottom|inset)\b/;
  for (const { rel, src } of SOURCES) {
    assert.ok(!banned.test(src), `${rel}: an arbitrary animation must not move a layout property`);
  }
});

test("floor 3: the stylesheet's periods are the shared table's periods", () => {
  const css = readFileSync(join(frontend, "app", "globals.css"), "utf8");
  const declarations = phaseDeclarations();
  assert.ok(declarations.length >= 6, "the table must declare every project loop");
  for (const line of declarations) {
    assert.ok(css.includes(line), `globals.css must carry exactly: ${line}`);
  }
  // And the keyframes each declared property names must exist.
  for (const name of ["ambient-drift", "ambient-pulse", "sweep", "blip", "eq", "breathe"]) {
    assert.ok(css.includes(`@keyframes ${name} {`), `globals.css must define @keyframes ${name}`);
  }
});

test("the phase table spreads delays instead of clumping them", () => {
  for (const name of Object.keys(PHASE_SECONDS) as Array<keyof typeof PHASE_SECONDS>) {
    const period = PHASE_SECONDS[name];
    const offsets = [0, 1, 2, 3, 4, 5].map((i) => Number.parseFloat(phaseDelay(i, name)));
    for (const offset of offsets) {
      assert.ok(offset >= 0 && offset < period, `${name}: delay ${offset}s must sit inside the ${period}s period`);
    }
    // No two consecutive elements share a delay. Two starting together is
    // exactly what the table exists to prevent.
    for (let i = 1; i < offsets.length; i += 1) {
      assert.notEqual(offsets[i], offsets[i - 1], `${name}: delays ${i - 1} and ${i} collide`);
    }
    // And they do not collapse onto a handful of values.
    assert.ok(new Set(offsets).size >= 5, `${name}: delays clump — the spread collapsed`);
  }
});

test("the ambient layers this project renders are real files", () => {
  for (const rel of [
    "app/_components/landing/GridDrift.tsx",
    "app/(dashboard)/dashboard/_components/ambient-layer.tsx",
    "app/(dashboard)/dashboard/_components/card-wash.tsx",
  ]) {
    assert.ok(existsSync(join(frontend, rel)), `${rel} must exist`);
  }
});
