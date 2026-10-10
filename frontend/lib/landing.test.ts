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
  // The attract loop keeps its caret and its typed `clear` — there is no real
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
  assert.ok(playground.includes("Demo — simulated output"), "the visible caption must name the demo state");
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
  // The eyebrow asserts the benefit, and asserts the jargon is GONE: "OSINT"
  // and "PASSIVE" were both mechanism words on a visitor-facing surface.
  assert.ok(hero.includes("PUBLIC RECORDS ONLY"), "eyebrow keeps its copy");
  assert.ok(!/PASSIVE OSINT/i.test(hero), "eyebrow no longer leaks OSINT jargon");
  assert.ok(!/\bpassive\b/i.test(hero), "hero does not describe the collection method");
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
  // product, and it is the one bug here that a designer cannot fix later — so
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
    "the row count can never exceed the number of stacks — no padded rows",
  );
  assert.ok(
    /resolvedStacks\.length === 0\) return null/.test(marquee),
    "no content must render nothing, not a placeholder row",
  );
  // The drift is driven per frame from a measured width, so the motion-safe
  // gate cannot be a `motion-safe:` class — it has to be the hook.
  assert.ok(
    /const reduceMotion = Boolean\(useReducedMotion\(\)\)/.test(marquee),
    "the reduced-motion gate is the hook, not a class",
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
  // its `.dark` override — not in the module, because CSS Modules rejects
  // `:root`/`.dark` as impure selectors and the whole sheet fails to compile
  // if they are put there.
  const css = readFileSync(
    join(here, "..", "components", "ui", "toolchain-marquee-utils", "toolchain-marquee.module.css"),
    "utf8",
  );
  assert.ok(!/:root\s*\{/.test(css), "a CSS module cannot declare :root — the sheet would not compile");
  assert.ok(!/^[^\S\n]*\.dark\s*\{/m.test(css), "a CSS module cannot declare .dark — the sheet would not compile");
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
