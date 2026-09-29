import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "..", "app", "_components", "landing");
const files = readdirSync(dir).filter((f) => f.endsWith(".tsx"));
const sources = Object.fromEntries(
  files.map((f) => [f, readFileSync(join(dir, f), "utf8")]),
);
const all = Object.values(sources).join("\n");

test("single CTA label per intent", () => {
  assert.ok(all.includes("Open dashboard"));
  for (const banned of ["Get started", "Try free", "Learn more", "Sign up"]) {
    assert.ok(!all.includes(banned), `banned CTA variant: ${banned}`);
  }
});

test("no fake precision stats or testimonials", () => {
  assert.ok(!/%/.test(all.replace(/00E59B/g, "")), "no percentage claims");
  assert.ok(!/\d+\.\d+×/.test(all), "no multiplier claims");
});

test("no raw HTML injection vectors", () => {
  for (const [f, src] of Object.entries(sources)) {
    assert.ok(!src.includes("dangerouslySetInnerHTML"), f);
    assert.ok(!src.includes("javascript:"), f);
  }
});

test("remote images are placeholders with replacement slots", () => {
  assert.ok(all.includes("picsum.photos/seed/"), "picsum seeds required");
  assert.ok(all.includes("TODO: ganti foto asli"), "replacement TODO required");
});

test("terminal typing FX contract", () => {
  const typer = sources["TerminalTyper.tsx"];
  assert.ok(typer, "TerminalTyper.tsx must exist");
  assert.ok(typer.includes("useReducedMotion"), "reduced-motion fallback required");
  assert.ok(typer.includes('aria-live="polite"'), "live region required");
  assert.ok(typer.includes("scan example.com"), "SSR command text required");
  assert.ok(typer.includes("!mounted"), "SSR static baseline required");
  const hero = sources["Hero.tsx"];
  assert.ok(hero.includes("TerminalTyper"), "Hero must render TerminalTyper");
  assert.ok(hero.includes('role="log"'), "terminal window must be role=log, not role=img");
});

test("motion uses transform/opacity only via Reveal", () => {
  const reveal = sources["Reveal.tsx"];
  assert.ok(reveal.includes("useReducedMotion"), "reduced-motion fallback required");
  assert.ok(reveal.includes("y: 24") || reveal.includes("opacity"), "transform/opacity only");
  for (const [f, src] of Object.entries(sources)) {
    if (f === "Reveal.tsx") continue;
    assert.ok(!src.includes("addEventListener"), `${f}: no manual scroll listeners`);
  }
});
