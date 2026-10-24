import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
// The attract samples and the signed-out playground scans MUST be the same data.
// They were two separate copies, which is a drift trap: editing one silently
// made `scan example.com` disagree with the sample the visitor just watched.
const samples = readFileSync(
  join(here, "..", "app", "_components", "landing", "playground-samples.ts"),
  "utf8",
);
const demo = readFileSync(
  join(here, "..", "app", "_components", "landing", "playground-demo.ts"),
  "utf8",
);

test("the playground demo and the static hero are one dataset", () => {
  assert.ok(samples.includes("scan example.com"), "the shared samples must exist");
  assert.ok(
    sources["TerminalTyper.tsx"].includes('from "./playground-samples"'),
    "TerminalTyper must read the shared samples, not keep its own copy",
  );
  assert.ok(
    demo.includes('from "./playground-samples"'),
    "the demo fixtures must be derived from the shared samples",
  );
  // The invented numbers must never be attributed to a real organisation.
  // Comments are stripped first: the header explains at length WHY these
  // companies were dropped, and naming them there is the opposite of a claim.
  const sampleData = samples.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const banned of ["wikipedia", "github", "cloudflare.com"]) {
    assert.ok(!sampleData.includes(banned), `samples must not fabricate results for ${banned}`);
  }
});

test("single CTA label per intent", () => {
  assert.ok(all.includes("Open dashboard"));
  for (const banned of ["Get started", "Try free", "Learn more", "Sign up"]) {
    assert.ok(!all.includes(banned), `banned CTA variant: ${banned}`);
  }
});

test("no fake precision stats or testimonials", () => {
  // Strip gradient color-stop percentages (e.g. `transparent_62%`, `at_50%_30%`)
  // and the CDN emerald param before looking for marketing claims. Also strip
  // bracket-wrapped geometry percentages (`[-72%]`, `[95%]`, `[124%]`) -
  // Tailwind arbitrary sizing in the hero band decoration (2026-10-16). Those
  // are layout tokens inside class brackets, not copy: a claim would read
  // "98% faster", unbracketed, and still fails this assertion.
  const copy = all
    .replace(/(transparent|at|_)\d+%/g, "$1")
    .replace(/_50%_30%/g, "")
    .replace(/\[-?\d+(\.\d+)?%\]/g, "")
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
  assert.ok(samples.includes("scan example.com"), "SSR command text required");
  assert.ok(typer.includes("!mounted"), "SSR static baseline required");
  const hero = sources["Hero.tsx"];
  // The hero window now wraps the interactive playground, which owns the
  // attract phase by rendering TerminalTyper until the visitor types.
  const playground = sources["PlaygroundTerminal.tsx"];
  assert.ok(playground, "PlaygroundTerminal.tsx must exist");
  assert.ok(playground.includes("TerminalTyper"), "attract phase must reuse TerminalTyper");
  assert.ok(hero.includes("PlaygroundTerminal"), "Hero must render PlaygroundTerminal");
  assert.ok(hero.includes('role="log"'), "terminal window must be role=log, not role=img");
});

test("playground: one prompt, one caret, no layout jump", () => {
  const playground = sources["PlaygroundTerminal.tsx"];
  const typer = sources["TerminalTyper.tsx"];
  // ONE input, and it is a line of the transcript rather than a field bolted
  // on underneath. A real <input> in its own bordered strip made the window
  // read as "a terminal" sitting next to "a search box" instead of one
  // terminal, so the prompt now renders as the final line, same styling.
  // The attract loop keeps its caret and its typed `clear` - there is no real
  // prompt to collide with until a session starts, and hiding it left a
  // dead-looking window.
  assert.ok(
    playground.includes("suppressCaret={session}"),
    "the attract caret must survive until a session actually starts",
  );
  assert.ok(typer.includes("suppressCaret"), "TerminalTyper must honour suppressCaret");
  assert.ok(
    typer.includes("done && rotating && !suppressCaret"),
    "the attract loop's own prompt line must be suppressed too, not just its caret",
  );
  assert.ok(!playground.includes("border-t border-neutral-200"), "the prompt must not be a separated strip");
  // A painted block beside the input duplicated the native caret and jumped
  // around while typing, so the native caret is recoloured instead.
  assert.ok(playground.includes("caret-accent"), "recolour the native caret, never paint a second one");
  // The attract caret is thin for the same reason: a wide painted block next to
  // the native caret reads as two inputs, and it wobbled while typing.
  assert.ok(typer.includes("w-[2px]"), "the attract caret must be a thin bar, not a wide block");
  assert.ok(!typer.includes("w-2 bg-accent"), "the wide block caret duplicated the live prompt's caret");
  // Fixed height: switching attract -> live resized the hero mid-read.
  assert.ok(playground.includes("WINDOW_HEIGHT"), "the window height must be a single fixed token");
  assert.ok(playground.includes("mt-auto"), "output must stack upward from the prompt like a real shell");
  // Shell recall. Without it, the up arrow moved the text cursor inside a
  // one-line input and appeared to do nothing.
  assert.ok(playground.includes("ArrowUp"), "the up arrow must recall the previous command");
  assert.ok(playground.includes("ArrowDown"), "the down arrow must walk forward and clear");
  // Up must land on the NEWEST command. An earlier version applied its starting
  // offset and then the step as well, so up opened on the oldest entry.
  assert.ok(
    playground.includes("idx = history.length - 1"),
    "the first up press must enter history at its newest entry",
  );
  // A CLICK takes the terminal over. Hover was tried and rejected: the pointer
  // crosses the window on its way somewhere else, so merely passing over the
  // hero blanked the output and stole the keyboard.
  assert.ok(playground.includes("onMouseDown"), "clicking the terminal must take it over");
  assert.ok(!playground.includes("onMouseEnter"), "hover must not take the terminal over");
  assert.ok(!playground.includes("onMouseLeave"), "the window must not change on pointer exit");
  assert.ok(playground.includes("onBlur"), "clicking elsewhere must hand the window back to the attract loop");
  // The clear is animated, never a silent vanish.
  assert.ok(playground.includes("WIPE_EXIT_S") && playground.includes("WIPE_STAGGER_S"), "the clear must be animated");
  assert.ok(playground.includes("wiping ? { opacity: 0, y: -6 }"), "the wipe must exit, not just disappear");
  // A TYPED `clear` is still only a felt effect: emptying the transcript at
  // command time reads as the terminal breaking, so it must run the same wipe
  // and let `finishWipe` empty the transcript once the exit has played. The
  // WHY prose is stripped first because the window this pins is small.
  const playgroundCode = playground
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.ok(
    /if \(parsed\.command === "clear"\)[\s\S]{0,300}?startWipe\("in"\)/.test(playgroundCode),
    "the typed clear must run the wipe, not empty the transcript at once",
  );
  assert.ok(
    !/if \(parsed\.command === "clear"\)[\s\S]{0,300}?startWipe\("out"\)/.test(playgroundCode),
    "a typed clear must not hand the window back to the attract loop",
  );
  assert.ok(
    !/setEntries\(\[\]\);\s*\n\s*return/.test(playgroundCode),
    "the transcript must not be emptied at command time",
  );
  // The scrollbar is themed from the project's own tokens, not the OS default.
  assert.ok(playground.includes("terminal-scroll"), "the transcript must use the themed scrollbar");
  assert.ok(
    readFileSync(join(here, "..", "app", "globals.css"), "utf8").includes(".terminal-scroll"),
    "the themed scrollbar must be defined in globals.css",
  );
  // Row descriptions must be able to render dimmer than their command.
  assert.ok(playground.includes("part.dim"), "rows must carry a dim flag for their description");
});

test("playground: list is required before scan, and demo output is labelled", () => {
  const playground = sources["PlaygroundTerminal.tsx"];
  // The gate itself lives in lib/playground-commands.ts and is pinned by its
  // own unit tests. What is pinned here is that the component actually routes
  // every keystroke through that parser rather than re-implementing the rules.
  assert.ok(playground.includes("parseCommand"), "input must go through the shared parser");
  assert.ok(playground.includes("HELP_LINES"), "help must come from the shared grammar");
  assert.ok(playground.includes("setListed(true)"), "list must unlock scan");
  // The honesty rule: simulated output is announced above the output and in the
  // visible caption. A demo badge that can be missing is a demo that can be
  // mistaken for a real scan.
  assert.ok(playground.includes("DEMO_NOTICE"), "simulated output must print its notice");
  assert.ok(playground.includes("DEMO_LIST_NOTICE"), "the target list must say it is simulated");
  assert.ok(playground.includes("DEMO_SIGN_IN_HINT"), "out-of-list targets must say what unlocks real scans");
  assert.ok(playground.includes("Demo: sample data"), "the visible caption must name the demo state");
  // Signed-out scans must never reach the network; a fetch here is allowed only
  // on the signed-in branch, which is asserted above by construction.
  assert.ok(playground.includes("if (signedIn) await runLiveScan"), "only signed-in sessions run a real scan");
  assert.ok(playground.includes("runDemoScan(parsed.target)"), "signed-out sessions run the fixture path");
});

test("playground: the prompt is client-only and no analyst target is server-rendered", () => {
  const playground = sources["PlaygroundTerminal.tsx"];
  // The prompt belongs to a session and to nothing else, so it cannot reach the
  // server-rendered HTML. A dead input is worse than no input.
  assert.ok(playground.includes("{session ? ("), "the prompt must render only inside a session");
  assert.ok(
    playground.includes("disabled={busy || wiping}"),
    "the prompt must be locked while the clear plays, so nobody types into a mid-wipe screen",
  );
  // Signed-in history is fetched inside `list`, never passed down from
  // page.tsx, so an unmasked target cannot reach cacheable HTML.
  assert.ok(playground.includes("fetchHistory()"), "history must be fetched client-side inside list");
  assert.ok(!page.includes("fetchHistory"), "the landing page must not server-render the history");
  assert.ok(page.includes("signedIn={signedIn}"), "the page tells the terminal whether a session exists");
  assert.ok(!playground.includes("dangerouslySetInnerHTML"), "no HTML injection vector in the terminal");
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
  // not inside the centered max-w section - so it never shows hard edges.
  assert.ok(page.includes("AmbientBackdrop"), "page-level layer must render the ambient backdrop");
  assert.ok(page.includes("-z-10"), "ambient layer must sit behind content");
  assert.ok(page.includes("[mask-image:"), "ambient layer must fade out, not end in a hard cut");
  assert.ok(page.includes('aria-hidden="true"'), "page-level layer is decorative-only");
  assert.ok(!hero.includes("AmbientBackdrop"), "Hero keeps content only - no boxed-in backdrop");
});

// Rewritten 2026-10-14: the node-graph scene this test used to pin
// (`Ambient3DInner.tsx`) is gone with the hero revision - the hero's picture is
// now the cobe globe (`HeroGlobe.tsx`), and every floor this test defended
// moved with it.
test("hero globe: token colours, shared rotation period, masked below the copy", () => {
  const globe = sources["HeroGlobe.tsx"];
  assert.ok(globe, "HeroGlobe.tsx must exist");
  // The picture this replaced was a torus knot in a hardcoded cyan that no
  // token chose, centred on the headline in both themes. Nothing here may
  // declare a colour of its own: the accent arrives as --accent or not at all.
  assert.ok(!/#[0-9a-fA-F]{3,8}/.test(globe), "the hero globe declares no colour literal");
  assert.ok(globe.includes('from "@/lib/ambient-colors"'), "colours are read from the design tokens");
  assert.ok(globe.includes("MutationObserver"), "the tokens are re-read when the theme flips");
  // Rotation is measured in seconds, from the shared table - never in frames,
  // which made the same scene turn at a different speed on every display.
  assert.ok(globe.includes("PHASE_SECONDS.globe"), "rotation speed comes from the shared table");
  assert.ok(globe.includes("Math.min((now - last)"), "rotation advances by elapsed time, not by frame count");
  assert.ok(globe.includes("useRef(0)"), "phi lives in a ref, so a re-render cannot reset the rotation");
  assert.ok(globe.includes("useReducedMotion"), "the globe is static when motion is not allowed");
  assert.ok(globe.includes("IntersectionObserver"), "off-screen scenes stop burning frames");
  assert.ok(globe.includes('aria-hidden="true"'), "the picture is decorative-only");
  assert.ok(globe.includes("[mask-image:"), "the globe sits below the copy instead of on top of it");
  assert.ok(globe.includes("removeEventListener"), "the globe's own listeners are cleaned up");
  // Rewritten 2026-10-16: the exact-string pin `<HeroGlobe />` could not
  // survive the interactive-flanks revision - the call now carries the lifted
  // selection props (`<HeroGlobe selected={selected} onSelect={setSelected} />`),
  // which is the whole point of the change. What stays pinned is the same
  // thing the old string asserted: the hero renders the globe. The prop
  // wiring itself is pinned by the flank contract test below.
  assert.ok(sources["Hero.tsx"].includes("<HeroGlobe "), "the hero renders the globe");
  // The page-level node-graph layer is gone, not merely unmounted.
  assert.ok(!page.includes("Ambient3D"), "the ambient node-graph layer must stay deleted from the page");
  assert.ok(!page.includes("GlobeSection"), "the standalone globe section must stay deleted from the page");
});

test("the hero globe keeps an sr-only honesty line and its example-website markers", () => {
  const globe = sources["HeroGlobe.tsx"];
  assert.ok(globe, "HeroGlobe.tsx must exist");
  // The old globe section shipped as a heading, a stub line and the caption
  // printed twice - with the whole section aria-hidden, so a screen reader got
  // nothing at all. The hero globe is decoration inside the hero, so the
  // rule is: only the canvas is hidden from AT, and the honesty line stays in the accessibility tree (sr-only - the operator removed the visible caption, 2026-10-15).
  // 2026-10-21: the globe gained two decorative caret glyphs inside its tilt
  // buttons. What must still hold is that the CANVAS is the picture and stays
  // out of the accessibility tree, while the controls around it are labelled.
  const hidden = globe.match(/aria-hidden="true"/g) ?? [];
  assert.equal(hidden.length, 3, "canvas and the two caret glyphs are the only hidden nodes");
  assert.ok(
    /<canvas\s+ref=\{canvasRef\}\s+aria-hidden=/.test(globe),
    "the picture stays decorative",
  );
  const glyphs = globe.match(/<Caret(?:Up|Down) size=\{\d+\} weight="bold" aria-hidden="true" \/>/g) ?? [];
  assert.equal(glyphs.length, 2, "both tilt glyphs are decoration, their buttons carry the name");
  const captions = globe.match(/Illustrative - not scan data/g) ?? [];
  assert.equal(captions.length, 1, "one honesty line, sr-only - not one per surface");
  // JSX wraps prose across lines, so copy assertions run against a single-line
  // version of the file - otherwise every sentence is split at the fold.
  const flat = globe.replace(/\s+/g, " ");
  assert.ok(
    flat.includes("example website points at arbitrary positions"),
    "the caption names the markers for what they are: arbitrary illustrative points, not locations",
  );
  assert.ok(globe.includes('className="sr-only"'), "the visible caption is gone; the honesty line is screen-reader-only (operator, 2026-10-15)");
  assert.ok(/<p className="sr-only">\s*Illustrative - not scan data/.test(globe), "the sr-only line carries the honesty text");
  assert.ok(!globe.includes("drag to spin"), "the visible drag hint is deleted; the grab cursor carries the affordance");
  // The markers are the site's own reserved-name demo targets, positioned by
  // a deterministic hash of the name - never a fabricated city list.
  assert.ok(globe.includes("DEMO_SCANS"), "the markers are the site's own example targets");
  assert.ok(globe.includes("mulberry32"), "marker positions are deterministic, not re-rolled per mount");
  assert.ok(globe.includes("readScene()"), "colours are re-sampled on every theme flip, not once at mount");
  assert.ok(globe.includes("Math.min((now - last)"), "rotation advances by elapsed time, not by frame count");
});

// 2026-10-21: on touch the canvas keeps `pan-y` so the page can scroll, which
// leaves the drag horizontal-only. These buttons are the vertical axis for a
// thumb - not decoration, so they carry a real 44px target and a real label.
test("hero globe: touch tilt buttons with 44px targets and clamped travel", () => {
  const globe = sources["HeroGlobe.tsx"];
  assert.ok(globe, "HeroGlobe.tsx must exist");
  for (const label of ["Tilt globe up", "Tilt globe down"]) {
    assert.ok(globe.includes(`aria-label="${label}"`), `${label} must be a labelled control`);
  }
  const targets = globe.match(/pointer-events-auto flex h-11 w-11/g) ?? [];
  assert.equal(targets.length, 2, "both tilt buttons are 44x44 and opt into the pointer");
  assert.ok(globe.includes("lg:hidden"), "the buttons are for touch widths only - lg+ has the drag");
  assert.ok(globe.includes("tiltRef.current(-0.12)"), "up tilts by one step");
  assert.ok(globe.includes("tiltRef.current(0.12)"), "down tilts by one step");
  assert.ok(
    globe.includes("Math.min(TILT_MAX, Math.max(TILT_MIN, thetaRef.current + delta))"),
    "button travel is clamped to the same range as the drag",
  );
  assert.ok(globe.includes("useRef<(delta: number) => void>"), "the buttons drive the scene through a ref, not a re-render");
  assert.ok(globe.includes("[touch-action:pan-y]"), "the canvas keeps pan-y - the buttons exist because of it");
});

// Operator, 2026-10-16: the band's lg+ flanks were "too empty" even after the
// passive decoration landed - the ask was an INTERACTIVE component, not more
// washes. What must stay true now that `HeroFlanks.tsx` exists:
//   - one selection, owned by Hero, forwarded to the globe AND the chips;
//   - the chips are the shared demo targets, single-select with toggle-off,
//     announced via aria-pressed, keyboard reachable, hover via colour only;
//   - the readout's facts come from the /demo fixtures by IMPORT (one source
//     of truth - the nvd failure scripted for api.acme.co must not be copied
//     by hand into a second table);
//   - lg+ only, token colours only, no keyframe loops, no pointer theft.
test("hero flanks: interactive example-target panels beside the globe", () => {
  const flanks = sources["HeroFlanks.tsx"];
  assert.ok(flanks, "HeroFlanks.tsx must exist in the landing components dir");
  const hero = sources["Hero.tsx"];
  const globe = sources["HeroGlobe.tsx"];
  // State flow: Hero owns the selection and both consumers receive it.
  assert.ok(
    hero.includes("useState<string | null>(null)"),
    "the selection state lives in the hero (null = resting)",
  );
  assert.ok(
    hero.includes("selected={selected}") && hero.includes("onSelect={setSelected}"),
    "the hero passes the selection and its toggle into the globe band",
  );
  assert.ok(
    globe.includes("<HeroFlanks selected={selected} onSelect={onSelect} />"),
    "the band renders the flanks with the same lifted state",
  );
  // Placement: lg+ only - below lg the sphere fills the band and there is no
  // side space for a panel.
  assert.ok(flanks.includes("hidden lg:block"), "the flanks render at lg and up only");
  // Chips: the shared targets, announced toggle semantics, toggle-off, keys.
  assert.ok(
    flanks.includes('from "./playground-samples"'),
    "the chips are the shared demo targets, not a second list",
  );
  assert.ok(/aria-pressed/.test(flanks), "a selected chip is announced to AT, not just painted");
  assert.ok(
    flanks.includes("onSelect(on ? null : target)"),
    "clicking the active chip again clears the selection",
  );
  assert.ok(flanks.includes("focus:ring-accent"), "the chips are keyboard reachable with the token ring");
  assert.ok(
    flanks.includes("transition-colors") && !flanks.includes("animate-"),
    "hover/selection feedback is a colour transition, never a keyframe loop",
  );
  // Pointer discipline: the band keeps pointer-events-none; only real
  // controls opt back in. Drag-to-spin must still reach the canvas.
  assert.ok(globe.includes("pointer-events-none"), "the band root keeps pointer-events-none");
  assert.ok(
    !/<(?:section|div|ul|li|p)[^>]*onClick/.test(flanks),
    "only the chip buttons and the links are controls - no layout element handles clicks",
  );
  assert.ok(
    flanks.includes("pointer-events-auto"),
    "the real controls opt into the pointer explicitly",
  );
  // Readout honesty: fixture facts by import, the sample badge, the two links.
  assert.ok(
    flanks.includes('from "../../demo/demo-report"'),
    "the readout reads the /demo fixtures by import - no second hand-written fact table",
  );
  assert.ok(
    /<span[^>]*>\s*Sample\s*<\/span>/.test(flanks),
    "the readout is labelled as a sample, one short badge (DESIGN.md: one disclosure per page)",
  );
  assert.ok(
    flanks.includes('href="/demo"') && flanks.includes('href="/dashboard"'),
    "the readout links to the full demo report and to the dashboard",
  );
  // Globe emphasis: the selected target's label strengthens, anchor mechanics
  // (positionAnchor + --cobe-visible vars) untouched.
  assert.ok(globe.includes("target === selected"), "the selected target's label is emphasised");
  assert.ok(globe.includes("positionAnchor"), "the labels keep their CSS-anchor binding");
  assert.ok(globe.includes("transition-colors"), "the label emphasis is a colour transition");
  // Token colours only - zero hex literals across landing sources.
  assert.ok(!/#[0-9a-fA-F]{3,8}/.test(flanks), "the flanks declare no colour literal");
});

test("full motion layer: scroll progress, parallax, bento visuals, risk meter", () => {
  const progress = sources["ScrollProgress.tsx"];
  assert.ok(progress, "ScrollProgress.tsx must exist");
  assert.ok(progress.includes("useScroll"), "progress bar reads scroll position");
  assert.ok(progress.includes("scaleX"), "progress bar animates transform scaleX only");
  assert.ok(progress.includes("useReducedMotion"), "progress bar hides on reduced motion");
  // Hydration (2026-10-14): the bar's `if (reduce) return null` was the second
  // instance of the reduce-only mismatch (after ParallaxField). Both must be
  // gated behind `mounted` or the bug simply moves to the next offender.
  const progressCode = progress
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.ok(
    progressCode.includes("if (!mounted || reduce) return null"),
    "the progress bar must render the same tree on server and pre-mount client",
  );

  const parallax = sources["ParallaxField.tsx"];
  assert.ok(parallax, "ParallaxField.tsx must exist");
  assert.ok(parallax.includes("useTransform"), "parallax drifts layers at scroll speed");
  assert.ok(parallax.includes('aria-hidden="true"'), "parallax is decorative-only");
  assert.ok(parallax.includes("useReducedMotion"), "parallax collapses on reduced motion");
  // Hydration fix (2026-10-14): `if (reduce) return null` mismatched the
  // server HTML in reduce mode only. Server and pre-mount render `null`
  // together; the real answer applies after a layout-effect mount. Comments
  // are stripped first because the file's own fix note quotes the old gate.
  const parallaxCode = parallax
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.ok(parallaxCode.includes("useLayoutEffect"), "the mount gate flips before paint, not a frame late");
  assert.ok(
    parallaxCode.includes("if (!mounted || reduce) return null"),
    "server and client must agree before mount",
  );
  assert.ok(!parallaxCode.includes("if (reduce) return null"), "the pre-mount mismatching gate must not come back");
  assert.ok(!parallax.includes("blur"), "no blur filters - transform-only parallax");
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

test("how-it-works names the report's parts, not a painted skeleton", () => {
  const how = sources["HowItWorks.tsx"];
  // The right-hand panel used to be three empty pills - rounded bars with a
  // looping pulse, standing in for a list nobody had written. A div that looks
  // like content and carries none is the one template tell that actually
  // deceives, because it implies a screenshot of a real result.
  // Renamed 2026-10-24: these rows no longer carry the partial-failure story
  // (the strip's failure sentence was removed at the operator's request). The
  // landing page's one failure disclosure is `FeatureBento`'s lead, so a test
  // that named this panel as the disclosure was pinning a claim it stopped
  // making - the assertions below never checked failure copy.
  assert.ok(!how.includes("rounded-full bg-accent/40"), "the fake content pills must not come back");
  // Real sentences, one per data source, from the one place they are declared.
  assert.ok(how.includes('from "./source-copy"'), "the panel reads the shared source copy");
  assert.ok(how.includes("s.result"), "every row names the part of the report it fills");
  assert.ok(how.includes("s.outcome"), "every row says what the visitor gets from that part");
  // Four sources are declared, so four rows render. One per source, no extras.
  const rows = how.match(/<li key=\{s\.mark\}/g) ?? [];
  assert.ok(rows.length === 1, "exactly one row template, rendered per source");
  const sourceCopy = readFileSync(join(here, "..", "app", "_components", "landing", "source-copy.ts"), "utf8");
  const marks = sourceCopy.match(/mark: "/g) ?? [];
  assert.ok(marks.length === 4, "the shared copy declares one entry per data source");
});

test("the bento lead is still the page's one partial-failure disclosure", () => {
  // The strip and the how-it-works rows lost their failure sentence on
  // 2026-10-24, which leaves this lead as the page's only statement about a
  // source that does not answer. It has to keep both halves: the report still
  // renders with the failed check named, AND an empty result is not an
  // all-clear. A rewrite that drops either half removes the disclosure
  // silently, because nothing else on the page says it.
  const bento = sources["FeatureBento.tsx"];
  assert.ok(
    bento.includes("A slow source never blanks the report."),
    "the bento lead still says a slow source does not blank the report",
  );
  assert.ok(
    bento.toLowerCase().includes("a gap is never good news"),
    "the bento lead still says a gap is not proof of safety",
  );
});

test("bento visuals read the shared sample figures, not a second set of numbers", () => {
  const bento = sources["BentoVisuals.tsx"];
  assert.ok(bento.includes("demoSampleMetrics"), "the bento reads the samples' own figures");
  assert.ok(!bento.includes("const BARS"), "no hand-written bar heights left to disagree with the terminal");
  assert.ok(!bento.includes("const GRID_CELLS"), "no hand-written grid cells left to disagree with the terminal");
  // The figures come out of the sample's own output lines, and a sample whose
  // copy stops carrying a number must degrade rather than invent one.
  assert.ok(samples.includes("export function sampleMetrics"), "the parser lives beside the samples");
  assert.ok(samples.includes("demoSampleMetrics"), "the samples export their figures to consumers");
});

test("looping motion: staggered blips, bobs and sweeps - all motion-safe", () => {
  const css = readFileSync(join(here, "..", "app", "globals.css"), "utf8");
  for (const key of ["sweep", "blip", "eq", "breathe"]) {
    assert.ok(css.includes(`--animate-${key}:`), `globals.css must define --animate-${key}`);
    assert.ok(css.includes(`@keyframes ${key}`), `globals.css must define @keyframes ${key}`);
  }
  // breathe must stay a gentle pulse: max 1.12x keeps rings inside the gap.
  assert.ok(/@keyframes breathe[\s\S]*?scale\(1\.12\)/.test(css), "breathe caps expansion at 1.12x");
  const hero = sources["Hero.tsx"];
  assert.ok(hero.includes("motion-safe:animate-blip"), "terminal traffic dots blip in a loop");
  // The stagger comes from the shared period table rather than from numbers
  // typed out per file. There used to be a literal `"0.6s"` here, `"1.5s"` in
  // how-it-works and `"0.18"` in the bento - three independent guesses at a
  // spread that nothing kept from collapsing into one beat.
  assert.ok(hero.includes('from "@/lib/motion-phases"'), "the hero reads the shared period table");
  assert.ok(hero.includes("phaseDelay("), "traffic dots take their stagger from the shared table");
  // The eyebrow asserts the benefit, and asserts the jargon is GONE: "OSINT"
  // and "PASSIVE" were both mechanism words on a visitor-facing surface.
  // Honesty-disclosure rules (DESIGN.md, 2026-10-18): the eyebrow is short -
  // "PUBLIC RECORDS ONLY" - and the DNS nameserver note lives ONCE, in the
  // hero paragraph, in plain words. The old footer/eyebrow repeats are gone.
  assert.ok(hero.includes("PUBLIC RECORDS ONLY"), "eyebrow keeps its copy");
  assert.ok(!/no packets/i.test(hero), "the packet mechanism line left the eyebrow");
  assert.ok(
    /Only DNS lookups reach\s+its nameservers/.test(hero),
    "the hero must disclose, once and in plain words, that DNS queries are visible to the target's nameservers"
  );
  assert.ok(hero.includes("animate-[ping_"), "eyebrow carries a radar ping");
  assert.ok(!hero.includes("animate-breathe"), "the CTA halo is gone - the button no longer breathes");
  assert.ok(hero.includes("animate-[spin_"), "terminal corner carries a rotating dial");
  const nav = sources["Nav.tsx"];
  assert.ok(nav.includes("motion-safe:animate-breathe"), "nav monogram breathes smoothly (no ping)");
  assert.ok(!nav.includes("animate-[ping_"), "nav monogram must not use the abrupt ping");
  const logos = sources["LogoStrip.tsx"];
  // The bob loop is gone: a perpetual up/down drift said "decoration" about
  // the records the product's evidence base is built from. The strip sits
  // still and answers when asked - click a source, get what it contributes
  // (2026-10-10; the when-slow half left the panel 2026-10-24).
  assert.ok(!logos.includes("animate-bob"), "the logo strip no longer bobs in a loop");
  assert.ok(!logos.includes("animationDelay"), "no staggered loop delay remains");
  assert.ok(logos.includes("useState"), "each source is selectable, so the strip is interactive");
  assert.ok(/aria-pressed/.test(logos), "the selected source is announced to AT, not just painted");
  assert.ok(logos.includes("hover:"), "chips give hover feedback instead of a loop");
  assert.ok(logos.includes("focus:ring-accent"), "chips are keyboard reachable");
  assert.ok(logos.includes('from "./Reveal"'), "the source panel still reveals on scroll");
  const bento = sources["BentoVisuals.tsx"];
  assert.ok(bento.includes("motion-safe:animate-sweep"), "port grid has a looping scanline sweep");
  assert.ok(bento.includes("motion-safe:animate-eq"), "metric bars keep equalizing in a loop");
  const security = sources["SecurityStrip.tsx"];
  assert.ok(!security.includes("animate-bob"), "security icons no longer bob in a loop");
  assert.ok(security.includes("hover:border-accent"), "security rows give hover feedback instead of a loop");
  assert.ok(security.includes("motion-reduce:group-hover:translate-y-0"), "hover lift disabled on reduced motion");
  const how = sources["HowItWorks.tsx"];
  // The live dot and its ping left with the fake ops skeleton; the panel's own
  // wash still breathes, gated, and nothing in the rows moves.
  assert.ok(!how.includes("animate-blip"), "the retired live dot must not come back");
  assert.ok(how.includes("motion-safe:animate-ambient-pulse"), "the panel wash pulses, gated");
  const meter = sources["RiskMeter.tsx"];
  assert.ok(meter.includes("motion-safe:animate-sweep"), "risk meter carries a looping shimmer");
  const parallax = sources["ParallaxField.tsx"];
  assert.ok(parallax.includes("motion-safe:animate-ambient-pulse"), "parallax washes pulse while resting");
  // Two washes that breathe on the same beat read as one moving surface, so each
  // takes a different phase from the shared table.
  assert.ok(parallax.includes("phaseDelay("), "parallax washes are offset against each other");
  // Washes must be clearly visible, not near-invisible ghosts, and must be
  // built from tokens so they follow the theme (2026-10-21: the old literal
  // rgba washes stayed black in light mode).
  const backdrop = sources["AmbientBackdrop.tsx"];
  assert.ok(backdrop.includes("hsl(var(--accent)/0.11)"), "hero wash opacity is visibly boosted");
  assert.ok(backdrop.includes("hsl(var(--foreground)/0.06)"), "the grid reads as a surface in both themes");

  // One period table, every consumer. `lib/motion-phases.ts` is the only place a
  // duration or a delay may be invented; the CSS declarations it generates are
  // the ones `globals.css` carries, asserted in lib/loop-contract.test.ts.
  // What is asserted here is that the sections actually read from it - a table
  // nobody imports is a table that has already drifted.
  const phases = readFileSync(join(here, "..", "lib", "motion-phases.ts"), "utf8");
  assert.ok(phases.includes("MOTION_PHASES"), "the shared period table exists");
  for (const layer of ["Hero.tsx", "ParallaxField.tsx", "BentoVisuals.tsx", "GridDrift.tsx"]) {
    assert.ok(
      sources[layer]?.includes('from "@/lib/motion-phases"'),
      `${layer} must take its periods from the shared table`,
    );
  }
  // The grid drift is the rearmost layer of the page-level stack, behind the
  // wash and the parallax washes - it is the plane the content sits on.
  const grid = sources["GridDrift.tsx"];
  assert.ok(grid, "GridDrift.tsx must exist");
  assert.ok(grid.includes('aria-hidden="true"'), "the grid is decorative-only");
  assert.ok(grid.includes("pointer-events-none"), "the grid cannot take a click");
  assert.ok(grid.includes("motion-safe:animate-ambient-drift"), "the grid drifts, gated");
  assert.ok(grid.includes("h-[100dvh]"), "the grid spans the viewport, not the content column");
  assert.ok(grid.includes("[mask-image:"), "the grid fades out instead of ending in a hard cut");
  assert.ok(page.includes("GridDrift"), "the page-level layer renders the grid drift");
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
    if (f === "Reveal.tsx" || f === "HeroGlobe.tsx") continue; // pointer + resize listeners permitted for cobe; cleanup (incl. removeEventListener) is required and asserted in the hero-globe contract above
    assert.ok(!src.includes("addEventListener"), `${f}: no manual scroll listeners`);
  }
});

test("tech stack: two named marquee rows, every name a real dependency", () => {
  const stack = sources["StackStrip.tsx"];
  assert.ok(stack, "StackStrip.tsx must exist");
  // The section is part of the locked page order, not a strip bolted on later:
  // it answers "what is this built with" after the security strip and before
  // the ask, so silently moving it reorders what the visitor reads.
  const slots = ["SecurityStrip", "StackStrip", "CtaFooter"].map((t) =>
    page.indexOf(`<${t} />`),
  );
  assert.ok(
    slots.every((i) => i !== -1),
    "page.tsx must render the security strip, the stack strip and the CTA",
  );
  assert.ok(
    slots[0] < slots[1] && slots[1] < slots[2],
    "the stack strip must sit between the security strip and the CTA",
  );
  // The marquee renders this section now, not the macOS dock that used to.
  // Asserted both ways, because the dock was a template component that would
  // have sat idle in `components/ui/` forever with no caller to notice.
  assert.ok(stack.includes("ToolchainMarquee"), "the section must render the marquee");
  assert.ok(!stack.includes("macos-dock"), "the dock this replaced must not come back");
  assert.ok(
    !existsSync(join(here, "..", "components", "ui", "macos-dock.tsx")),
    "the unused dock component must stay deleted, not sit idle in components/ui",
  );

  // Every claimed name is a dependency this repo really has. A tech-stack
  // section that invents a tool to fill a row is a false claim about the
  // product, and it is the one bug here that a designer cannot fix later - so
  // the mapping is checked against the manifest files themselves rather than
  // trusted from the source array.
  const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  const npm: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };
  const py = readFileSync(join(here, "..", "..", "backend", "requirements.txt"), "utf8");
  const FRONTEND: Record<string, string> = {
    "Next.js": "next",
    "TypeScript": "typescript",
    "Tailwind CSS": "tailwindcss",
    Zod: "zod",
    "Chart.js": "chart.js",
    "Better Auth": "better-auth",
  };
  const BACKEND: Record<string, string> = {
    FastAPI: "fastapi",
    SQLAlchemy: "sqlalchemy",
    Alembic: "alembic",
    "Pydantic v2": "pydantic",
    httpx: "httpx",
  };
  // Pulled out of the source, so a label added without a mapping fails here
  // instead of shipping as decoration.
  const labels = [...stack.matchAll(/\{ label: "([^"]+)"/g)].map((m) => m[1]);
  assert.ok(labels.length >= 12, `expected both rows of names, found ${labels.length}`);
  for (const label of labels) {
    assert.ok(label.trim().length > 0, `a badge with an empty label is decoration: "${label}"`);
    if (label in FRONTEND) {
      assert.ok(FRONTEND[label] in npm, `${label} must be a frontend dependency (${FRONTEND[label]})`);
    } else if (label in BACKEND) {
      assert.ok(new RegExp(`^${BACKEND[label]}==`, "m").test(py), `${label} must be a backend dependency (${BACKEND[label]})`);
    } else if (label === "PostgreSQL") {
      // PostgreSQL is the database, not a package: what the manifests name is
      // its drivers, one per side.
      assert.ok(/^asyncpg==/m.test(py), "the backend drives Postgres through asyncpg");
      assert.ok("pg" in npm, "the frontend drives Postgres through pg");
    } else {
      assert.fail(`${label} is rendered but is not a mapped dependency`);
    }
  }

  // The section is marked by a heading, and the eyebrow stays gone.
  // DESIGN.md caps eyebrows at one per three sections and the landing already
  // spends them on the hero badge and how-it-works, so the h2 carries this.
  assert.ok(/<h2[\s>]/.test(stack), "the section needs its own heading");
  assert.ok(!stack.includes("WHAT IT IS BUILT ON"), "a third eyebrow on the landing breaks the eyebrow budget");
  assert.ok(!stack.includes("tracking-widest text-accent"), "no mono eyebrow line in this section");

  // Vendor colour travels through the CSS module, never as a literal here. The
  // dock this replaced had to ship hex inside a CDN URL param; the marquee has
  // no remote image at all, so a hex in this file would be a second palette.
  assert.ok(!/#[0-9a-fA-F]{3,8}/.test(stack), "StackStrip declares no colour of its own");
  assert.ok(!/00E59B/i.test(stack), "the accent emerald must arrive as a token, never as a literal");
  for (const token of ["--tool-nextjs", "--tool-postgres", "--tool-tailwind", "--tool-alembic"]) {
    assert.ok(stack.includes(`var(${token})`), `marks must take their colour from ${token}`);
  }
  assert.ok(stack.includes('aria-label="Tech stack used"'), "the section must keep its accessible name");

  // The marquee is honest about rows, copies and stopping.
  const marquee = readFileSync(join(here, "..", "components", "ui", "toolchain-marquee.tsx"), "utf8");
  assert.ok(
    marquee.includes("Math.min(rowCount, resolvedStacks.length)"),
    "the row count can never exceed the number of stacks - no padded rows",
  );
  assert.ok(
    /resolvedStacks\.length === 0\) return null/.test(marquee),
    "no content must render nothing, not a placeholder row",
  );
  // The drift is driven per frame from a measured width, so the motion-safe
  // gate cannot be a `motion-safe:` class - it has to be the hook.
  assert.ok(
    /const reduceMotion = Boolean\(useReducedMotion\(\)\) && mounted/.test(marquee),
    "the reduced-motion gate is the hook, not a class - and it applies only after mount (hydration)",
  );
  assert.ok(marquee.includes("useAnimationFrame"), "the distance travelled comes from a measurement");
  // One readable list of names: the duplicate groups exist only to fill the
  // viewport, and reading them out three times is a screen-reader bug.
  assert.ok(marquee.includes("aria-hidden={hidden || undefined}"), "duplicate groups must be hidden from AT");
  // Content that moves on its own has to be stoppable, so the control is part of
  // the component and the section asks for it.
  assert.ok(
    marquee.includes('aria-label={paused ? "Play tool animation" : "Pause tool animation"}'),
    "a moving row must offer a pause control",
  );
  assert.ok(stack.includes("showControl"), "the section must ask for the pause control");

  // The module holds the component's own surfaces and nothing else. Vendor
  // colour is declared once, in globals.css, beside every other page token and
  // its `.dark` override - not in the module, because CSS Modules rejects
  // `:root`/`.dark` as impure selectors and the whole sheet fails to compile
  // if they are put there.
  const css = readFileSync(
    join(here, "..", "components", "ui", "toolchain-marquee-utils", "toolchain-marquee.module.css"),
    "utf8",
  );
  assert.ok(!/:root\s*\{/.test(css), "a CSS module cannot declare :root - the sheet would not compile");
  assert.ok(!/^[^\S\n]*\.dark\s*\{/m.test(css), "a CSS module cannot declare .dark - the sheet would not compile");
  for (const templateToken of ["--bg:", "--text:", "--muted:", "--surface:"]) {
    assert.ok(!css.includes(templateToken), `no second palette: the template's ${templateToken} must not be redeclared`);
  }
  assert.ok(css.includes("hsl(var(--card))") && css.includes("hsl(var(--btn-border))"), "the badge paints from page tokens, so it follows dark/light for free");
  assert.ok(css.includes("data-reduced-motion") && css.includes("overflow-x: auto"), "reduced motion turns the row into a scroll container");

  // Vendor colour is declared once, in globals.css, beside every other page token
  // and its `.dark` override.
  const tokens = readFileSync(join(here, "..", "app", "globals.css"), "utf8");
  for (const token of ["--tool-nextjs", "--tool-postgres", "--tool-tailwind", "--tool-alembic"]) {
    assert.ok(tokens.includes(`${token}: #`), `globals.css must declare ${token}`);
  }
  assert.ok(/\.dark\s*\{[^}]*--tool-nextjs:/.test(tokens), "the near-black Next.js glyph swaps per theme");
  const vendorHex = tokens.match(/--tool-[a-z]+:\s*#[0-9a-fA-F]{3,8}/g) ?? [];
  assert.ok(vendorHex.length >= 9, `every vendor colour is declared, found ${vendorHex.length}`);
});
