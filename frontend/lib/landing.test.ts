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
const page = readFileSync(join(here, "..", "app", "page.tsx"), "utf8");

test("single CTA label per intent", () => {
  assert.ok(all.includes("Open dashboard"));
  for (const banned of ["Get started", "Try free", "Learn more", "Sign up"]) {
    assert.ok(!all.includes(banned), `banned CTA variant: ${banned}`);
  }
});

test("no fake precision stats or testimonials", () => {
  // Strip gradient color-stop percentages (e.g. `transparent_62%`, `at_50%_30%`)
  // and the CDN emerald param before looking for marketing claims.
  const copy = all
    .replace(/(transparent|at|_)\d+%/g, "$1")
    .replace(/_50%_30%/g, "")
    .replace(/00E59B/g, "");
  assert.ok(!/%/.test(copy), "no percentage claims");
  assert.ok(!/\d+\.\d+×/.test(all), "no multiplier claims");
});

test("no raw HTML injection vectors", () => {
  for (const [f, src] of Object.entries(sources)) {
    assert.ok(!src.includes("dangerouslySetInnerHTML"), f);
    assert.ok(!src.includes("javascript:"), f);
  }
});

test("no placeholder remote-image scaffolding remains", () => {
  assert.ok(!all.includes("picsum.photos/seed/"), "picsum placeholders must be removed");
  assert.ok(!all.includes("TODO: ganti foto asli"), "placeholder TODO must be removed");
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

test("ambient backdrop is decorative-only and motion-safe", () => {
  const backdrop = sources["AmbientBackdrop.tsx"];
  assert.ok(backdrop, "AmbientBackdrop.tsx must exist");
  assert.ok(backdrop.includes('aria-hidden="true"'), "decorative backdrop must be hidden from AT");
  assert.ok(backdrop.includes("pointer-events-none"), "backdrop must not intercept clicks");
  assert.ok(backdrop.includes("motion-safe:"), "ambient animation must only run when motion is allowed");
  assert.ok(!backdrop.includes("00E59B") && !backdrop.includes("00e59b"), "no hardcoded emerald hex");
  assert.ok(!backdrop.includes("addEventListener"), "CSS-only ambient, no JS scroll listeners");
  const hero = sources["Hero.tsx"];
  // The ambient layer lives at page level (full-bleed behind nav + hero),
  // not inside the centered max-w section — so it never shows hard edges.
  assert.ok(page.includes("AmbientBackdrop"), "page-level layer must render the ambient backdrop");
  assert.ok(page.includes("-z-10"), "ambient layer must sit behind content");
  assert.ok(page.includes("[mask-image:"), "ambient layer must fade out, not end in a hard cut");
  assert.ok(page.includes('aria-hidden="true"'), "page-level layer is decorative-only");
  assert.ok(!hero.includes("AmbientBackdrop"), "Hero keeps content only — no boxed-in backdrop");
});

test("full motion layer: scroll progress, parallax, bento visuals, risk meter", () => {
  const progress = sources["ScrollProgress.tsx"];
  assert.ok(progress, "ScrollProgress.tsx must exist");
  assert.ok(progress.includes("useScroll"), "progress bar reads scroll position");
  assert.ok(progress.includes("scaleX"), "progress bar animates transform scaleX only");
  assert.ok(progress.includes("useReducedMotion"), "progress bar hides on reduced motion");

  const parallax = sources["ParallaxField.tsx"];
  assert.ok(parallax, "ParallaxField.tsx must exist");
  assert.ok(parallax.includes("useTransform"), "parallax drifts layers at scroll speed");
  assert.ok(parallax.includes('aria-hidden="true"'), "parallax is decorative-only");
  assert.ok(parallax.includes("useReducedMotion"), "parallax collapses on reduced motion");
  assert.ok(!parallax.includes("blur"), "no blur filters — transform-only parallax");
  const hero = sources["Hero.tsx"];
  assert.ok(page.includes("ParallaxField"), "page-level layer must render the parallax field");
  assert.ok(!hero.includes("ParallaxField"), "parallax is not boxed into the hero section");
  const nav = sources["Nav.tsx"];
  assert.ok(nav, "Nav.tsx must exist");
  assert.ok(nav.includes("ScrollProgress"), "Nav must render the scroll progress bar");

  const bento = sources["BentoVisuals.tsx"];
  assert.ok(bento, "BentoVisuals.tsx must exist");
  assert.ok(bento.includes("motion-safe:animate-ambient-pulse"), "grid visual breathes via the shared keyframe");
  assert.ok(bento.includes("scaleY"), "metric bars grow via transform scaleY only");
  assert.ok(bento.includes("useReducedMotion"), "metric bars are static on reduced motion");

  const meter = sources["RiskMeter.tsx"];
  assert.ok(meter, "RiskMeter.tsx must exist");
  assert.ok(meter.includes("scaleX"), "risk bar fills via transform scaleX only");
  assert.ok(meter.includes("useReducedMotion"), "risk bar is static on reduced motion");
});

test("CTA and card hovers lift with motion-reduce fallback", () => {
  for (const f of ["Hero.tsx", "Nav.tsx", "CtaFooter.tsx"]) {
    const src = sources[f];
    assert.ok(src.includes("hover:-translate-y-"), `${f}: CTA lifts on hover`);
    assert.ok(src.includes("motion-reduce:hover:translate-y-0"), `${f}: lift disabled on reduced motion`);
    assert.ok(src.includes("hover:shadow-accent/"), `${f}: CTA carries an accent shadow`);
  }
  const bento = sources["FeatureBento.tsx"];
  assert.ok(bento.includes("hover:-translate-y-1"), "bento cards lift on hover");
  assert.ok(bento.includes("hover:border-accent/40"), "bento cards highlight the accent border");
  assert.ok(bento.includes("motion-reduce:hover:translate-y-0"), "card lift disabled on reduced motion");
});

test("looping motion: staggered blips, bobs and sweeps — all motion-safe", () => {
  const css = readFileSync(join(here, "..", "app", "globals.css"), "utf8");
  for (const key of ["bob", "sweep", "blip", "eq", "breathe"]) {
    assert.ok(css.includes(`--animate-${key}:`), `globals.css must define --animate-${key}`);
    assert.ok(css.includes(`@keyframes ${key}`), `globals.css must define @keyframes ${key}`);
  }
  // breathe must stay a gentle pulse: max 1.12x keeps rings inside the gap.
  assert.ok(/@keyframes breathe[\s\S]*?scale\(1\.12\)/.test(css), "breathe caps expansion at 1.12x");
  const hero = sources["Hero.tsx"];
  assert.ok(hero.includes("motion-safe:animate-blip"), "terminal traffic dots blip in a loop");
  assert.ok(hero.includes('animationDelay: "0.6s"'), "traffic dots are staggered");
  assert.ok(hero.includes("PASSIVE OSINT"), "eyebrow keeps its copy");
  assert.ok(hero.includes("animate-[ping_"), "eyebrow carries a radar ping");
  assert.ok(hero.includes("motion-safe:animate-breathe"), "hero CTA halo breathes smoothly (no ping)");
  assert.ok(hero.includes("animate-[spin_"), "terminal corner carries a rotating dial");
  const nav = sources["Nav.tsx"];
  assert.ok(nav.includes("motion-safe:animate-breathe"), "nav monogram breathes smoothly (no ping)");
  assert.ok(!nav.includes("animate-[ping_"), "nav monogram must not use the abrupt ping");
  const logos = sources["LogoStrip.tsx"];
  assert.ok(logos.includes("motion-safe:animate-bob"), "logo strip bobs in a loop");
  assert.ok(logos.includes("animationDelay"), "logo bob is staggered");
  const bento = sources["BentoVisuals.tsx"];
  assert.ok(bento.includes("motion-safe:animate-sweep"), "port grid has a looping scanline sweep");
  assert.ok(bento.includes("motion-safe:animate-eq"), "metric bars keep equalizing in a loop");
  const security = sources["SecurityStrip.tsx"];
  assert.ok(security.includes("motion-safe:animate-bob"), "security icons bob in a loop");
  const how = sources["HowItWorks.tsx"];
  assert.ok(how.includes("motion-safe:animate-blip"), "how-it-works live dot blips");
  assert.ok(how.includes("animate-[ping_"), "how-it-works live dot pings");
  assert.ok(how.includes("motion-safe:animate-ambient-pulse"), "ops skeleton bars breathe in a loop");
  const meter = sources["RiskMeter.tsx"];
  assert.ok(meter.includes("motion-safe:animate-sweep"), "risk meter carries a looping shimmer");
  const parallax = sources["ParallaxField.tsx"];
  assert.ok(parallax.includes("motion-safe:animate-ambient-pulse"), "parallax washes pulse while resting");
  // Washes must be clearly visible, not near-invisible ghosts.
  const backdrop = sources["AmbientBackdrop.tsx"];
  assert.ok(backdrop.includes("0.11") && backdrop.includes("0.14"), "hero wash opacity is visibly boosted");
  // No loop may escape the reduced-motion gate.
  for (const [f, src] of Object.entries(sources)) {
    const ungated =
      src.match(/(?<!motion-safe:)animate-(bob|sweep|blip|eq|breathe|ping|pulse|ambient-pulse|ambient-drift|\[ping|\[spin)/g) ?? [];
    assert.ok(ungated.length === 0, `${f}: every looping animation must be motion-safe gated`);
  }
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
