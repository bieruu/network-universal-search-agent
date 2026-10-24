import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, "..", rel), "utf8");

const css = read("app/globals.css");
const layout = read("app/layout.tsx");
const toggle = read("components/ui/theme-toggle.tsx");
const authShell = read(join("app", "(auth)", "_components", "auth-shell.tsx"));
const signup = read(join("app", "(auth)", "sign-up", "sign-up-form.tsx"));
const button = read("components/ui/button.tsx");
const input = read("components/ui/input.tsx");
const badge = read("components/ui/badge.tsx");
const shell = read(join("app", "(dashboard)", "dashboard", "_components", "app-shell.tsx"));
const sidebar = read(join("components", "ui", "app-1-utils", "app-1-sidebar.tsx"));

const landingDir = join(here, "..", "app", "_components", "landing");
const landingFiles = readdirSync(landingDir).filter((f) => f.endsWith(".tsx"));
const landing: Record<string, string> = Object.fromEntries(
  landingFiles.map((f) => [f, readFileSync(join(landingDir, f), "utf8")]),
);
const landingAll = Object.values(landing).join("\n");

// String checks cannot catch CSS syntax errors (e.g. `//` comments inside
// @theme) - compile globals.css through the real Tailwind pipeline instead.
test("globals.css compiles through Tailwind - no syntax errors", async () => {
  const postcss = (await import("postcss")).default;
  const tailwind = (await import("@tailwindcss/postcss")).default;
  const result = await postcss([tailwind()]).process(css, {
    from: join(here, "..", "app", "globals.css"),
  });
  assert.ok(result.css.includes("@keyframes breathe"), "breathe keyframe must survive compilation");
  assert.ok(result.css.includes("@keyframes eq"), "eq keyframe must survive compilation");
});

test("shared tokens exist in light and dark themes", () => {
  for (const token of ["--background", "--foreground", "--accent", "--accent-foreground", "--accent-hover", "--muted", "--fg-muted", "--warning", "--danger", "--panel"]) {
    assert.ok(css.includes(token), `globals.css must define ${token}`);
  }
  assert.ok(css.includes("--background: 210 33% 6%"), "dark background is neutral #0a0f14, not blue");
  for (const color of ["accent", "accent-foreground", "accent-hover", "muted", "fg-muted", "warning", "danger", "panel"]) {
    assert.ok(css.includes(`--color-${color}:`), `Tailwind theme must map ${color}`);
  }
  assert.ok(css.includes('@custom-variant dark (&:where(.dark, .dark *))'), "dark utilities follow the html class");
  assert.ok(css.includes("--font-mono:"), "custom mono font utility remains available");
  assert.ok(css.includes("--shadow-input:"), "custom input shadow utility remains available");
  assert.ok(css.includes("--animate-ripple:"), "custom animations remain available");
});

test("surface tokens: band and card hold their own light/dark values", () => {
  // Added 2026-10-21. Light mode was painting cards and the how-it-works band
  // with near-black values borrowed from dark tokens (or with `bg-slate-50`
  // guesses that ignored the theme), so a light reader got unreadable cards.
  for (const token of ["--card", "--band", "--btn-border"]) {
    assert.ok(css.includes(`${token}:`), `globals.css must define ${token}`);
  }
  for (const token of ["--color-card", "--color-band", "--color-btn-border"]) {
    assert.ok(css.includes(`${token}:`), `Tailwind must map ${token}`);
  }
  assert.ok(/--band:\s*210 40% 97%/.test(css), "light band is a pale slate, not the page background");
  assert.ok(
    /\.dark\s*\{[^}]*--band:\s*210 32% 7%/.test(css),
    "dark band is its own step above the page, not the light value",
  );
  const card = read("components/ui/card.tsx");
  assert.ok(card.includes("bg-card"), "cards paint from the card token");
  assert.ok(card.includes("border-btn-border"), "cards take the shared border token");
  const tooltip = read("components/ui/tooltip.tsx");
  assert.ok(tooltip.includes("bg-card"), "tooltips sit on the card surface");
  assert.ok(tooltip.includes("border-btn-border"), "tooltips take the shared border token");
  assert.ok(tooltip.includes("text-foreground"), "tooltip text is the theme foreground");
  // The themed scrollbar follows the border token, so it cannot disappear in
  // light mode the way a hardcoded dark track did.
  assert.ok(/\.terminal-scroll[\s\S]*?--btn-border/.test(css), "the terminal scrollbar uses the border token");
});

test("fonts load once in the root layout, not per page", () => {
  const layout = read("app/layout.tsx");
  const home = read("app/page.tsx");
  assert.ok(layout.includes("Space_Grotesk"), "root layout must set Space Grotesk globally");
  assert.ok(layout.includes("--font-landing-mono"), "root layout must set the mono variable globally");
  assert.ok(!home.includes("next/font"), "landing must not duplicate font setup");
});

test("dark stays the default and the preference key is shared", () => {
  assert.ok(layout.includes('className="dark"'), "html defaults to dark");
  assert.ok(layout.includes("saved ? saved === 'dark' : true"), "no-saved-preference defaults to dark");
  assert.ok(toggle.includes('localStorage.getItem("theme")'), "toggle reads the shared key");
  assert.ok(toggle.includes('localStorage.setItem("theme"'), "toggle persists the shared key");
  assert.ok(toggle.includes('stored ? stored === "dark" : true'), "toggle defaults to dark like layout");
});

test("sign-in follows the shared palette in both themes", () => {
  assert.ok(authShell.includes("bg-background"), "auth base uses the theme token");
  assert.ok(!/#[0-9a-fA-F]{3,8}/.test(authShell), "auth shell declares no surface literal of its own");
  assert.ok(landingAll.includes("bg-background"), "the same token paints the landing, so the two agree");
  assert.ok(authShell.includes("text-slate-900 dark:text-neutral-100"), "headings pair light/dark");
  assert.ok(authShell.includes("text-accent-text"), "emerald text uses the text-only accent token");
  assert.ok(authShell.includes("bg-accent"), "emerald fills use the global accent token");
  assert.ok(!authShell.includes("00E59B"), "no hardcoded emerald hex in auth shell");
  assert.ok(signup.includes("AuthShell"), "sign-up shares the auth shell");
});

test("landing sections pair light/dark text, borders and surfaces", () => {
  for (const [f, src] of Object.entries(landing)) {
    assert.ok(!src.includes("text-neutral-50\"") || src.includes("dark:text-neutral-50"), `${f}: neutral-50 must be dark-paired`);
    const noUrls = src.replace(/https:\/\/cdn\.simpleicons\.org\/\S+/g, "");
    assert.ok(!noUrls.includes("00E59B"), `${f}: no hardcoded emerald hex - use *-accent utilities (CDN icon URLs excepted)`);
  }
  assert.ok(landingAll.includes("border-neutral-200"), "light borders exist");
  assert.ok(landingAll.includes("dark:border-neutral-800"), "dark borders kept");
  assert.ok(landingAll.includes("text-slate-900 dark:text-neutral-50"), "headings pair light/dark");
  assert.ok(landing["HowItWorks.tsx"].includes("bg-band"), "how-it-works has a light band surface");
  assert.ok(!landing["HowItWorks.tsx"].includes("bg-slate-50"), "the band is a token now, not a slate guess");
  assert.ok(landing["HowItWorks.tsx"].includes("border-btn-border"), "the band's rules use the shared border token");
  assert.ok(!landing["HowItWorks.tsx"].includes("dark:bg-[#0c1117]"), "the hardcoded dark band is gone");
  assert.ok(landing["Hero.tsx"].includes("bg-panel"), "terminal uses the shared panel token");
  assert.ok(landing["FeatureBento.tsx"].includes("bg-panel"), "bento matches the terminal surface");
  // The auth shell now carries a real transcript on the same panel token - the
  // sign-in screen used to spend that half of the screen on an icon orbit.
  assert.ok(authShell.includes("bg-panel"), "the auth shell's transcript sits on the shared panel token");
  assert.ok(authShell.includes("DEMO_SCANS"), "the auth panel prints the real sample transcript");
  assert.ok(!authShell.includes("ORBIT_ICONS"), "the icon orbit is gone, not restyled");
  assert.ok(!authShell.includes("lucide-react"), "the auth shell takes its icons from Phosphor");
});

test("primitives render in both themes", () => {
  for (const [name, src] of [["button", button], ["input", input], ["badge", badge]]) {
    assert.ok(src.includes("dark:"), `${name} must include dark: pairs`);
  }
  assert.ok(button.includes('"accent"'), "accent variant kept");
  assert.ok(button.includes("rounded-full"), "button base stays pill like landing CTAs");
  assert.ok(!button.includes("bg-white text-black"), "no dark-only default button");
  assert.ok(input.includes("border-accent/40"), "input border carries the emerald accent token");
  assert.ok(input.includes("bg-accent/5"), "input surface uses the emerald wash");
  assert.ok(input.includes("focus:ring-accent/30"), "input focus ring uses the accent token");
});

test("hover states stay inside the palette, no slate/neutral fills", () => {
  // The default (neutral) button keeps its slate base by design; what must go
  // are the old flat hover washes (slate-100/200, neutral-700/800).
  for (const banned of ["hover:bg-slate-100", "hover:bg-slate-200", "hover:bg-neutral-700", "hover:bg-neutral-800"]) {
    assert.ok(!button.includes(banned), `button must not hover ${banned}`);
  }
  assert.ok(button.includes("hover:bg-accent/10"), "ghost/outline hover uses the accent wash");
  assert.ok(button.includes("hover:bg-accent-hover"), "accent fill hovers into the accent-hover token");
  const table = read("components/ui/table.tsx");
  assert.ok(table.includes("hover:bg-accent/"), "table rows hover in the accent wash");
  assert.ok(sidebar.includes("hover:bg-accent/10"), "sidebar nav hovers in the accent wash");
  assert.ok(!sidebar.includes("hover:bg-input"), "sidebar no longer hovers on the flat input token");
  const history = read(join("app", "(dashboard)", "dashboard", "_components", "HistoryList.tsx"));
  assert.ok(history.includes("hover:bg-accent/10"), "history rows hover in the accent wash");
});

test("dashboard follows the shared palette in both themes", () => {
  for (const [name, src] of [["shell", shell], ["sidebar", sidebar]]) {
    const bare = (src.match(/(?<!dark:)text-neutral-500/g) ?? []).length;
    const paired = (src.match(/dark:text-neutral-/g) ?? []).length;
    assert.ok(bare === 0 || paired > 0, `${name}: neutral text must be theme-paired`);
    assert.ok(!src.includes("bg-[#0a0f14]"), `${name}: dashboard uses tokens, not hardcoded surfaces`);
  }
  assert.ok(sidebar.includes("tracking-widest text-accent-text"), "sidebar Sources header is an accent mono eyebrow");
  assert.ok(sidebar.includes("bg-accent/10 font-mono"), "source monogram chips use the accent wash");
  assert.ok(!sidebar.includes("bg-input"), "no flat monochrome input surface left in the sidebar");
});

// ---------------------------------------------------------------------------
// Contrast math. Tokens store bare channels ("160 100% 32%"), so the only way
// to check a ratio is to parse the theme block the browser will actually read.
// ---------------------------------------------------------------------------

type Rgb = [number, number, number];

function themeBlock(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `globals.css must declare a ${selector} block`);
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${selector} block`);
}

function token(block: string, name: string): [number, number, number] {
  const m = new RegExp(`--${name}:\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%`).exec(block);
  assert.ok(m, `${name} must be declared as "h s% l%"`);
  return [Number(m![1]), Number(m![2]), Number(m![3])];
}

function hslToRgb([h, s, l]: [number, number, number]): Rgb {
  const sat = s / 100;
  const lig = l / 100;
  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = lig - c / 2;
  return [r1 + m, g1 + m, b1 + m];
}

function luminance([r, g, b]: Rgb): number {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// CSS composites alpha in sRGB space, so alpha-over is mixed before luminance.
function over(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return [bg[0] * (1 - alpha) + fg[0] * alpha, bg[1] * (1 - alpha) + fg[1] * alpha, bg[2] * (1 - alpha) + fg[2] * alpha];
}

test("accent-text clears AA for small text on every light surface it sits on", () => {
  const light = themeBlock(":root");
  const dark = themeBlock(".dark");

  // The token is text-only by construction: it must be darker than the fill
  // token, not a copy of it.
  assert.ok(light.includes("--accent-text:"), "light theme declares --accent-text");
  assert.ok(dark.includes("--accent-text:"), "dark theme declares --accent-text");
  assert.ok(
    token(light, "accent-text")[2] < token(light, "accent")[2],
    "light --accent-text must be darker than --accent, which is tuned for fills",
  );

  const white: Rgb = [1, 1, 1];
  const lightText = hslToRgb(token(light, "accent-text"));
  const lightFill = hslToRgb(token(light, "accent"));
  const darkText = hslToRgb(token(dark, "accent-text"));
  const darkBg = hslToRgb(token(dark, "background"));

  const cases: Array<[string, number]> = [
    ["light accent-text on white", contrast(lightText, white)],
    ["light accent-text on bg-accent/10", contrast(lightText, over(lightFill, 0.1, white))],
    ["light accent-text on bg-accent/15", contrast(lightText, over(lightFill, 0.15, white))],
    ["dark accent-text on the dark background", contrast(darkText, darkBg)],
  ];
  for (const [label, value] of cases) {
    assert.ok(value >= 4.5, `${label} is ${value.toFixed(2)}:1, AA for small text needs 4.5:1`);
  }

  // The counter-example, pinned: the fill token is what this test exists to
  // reject, so reusing --accent as text colour must fail rather than drift.
  assert.ok(
    contrast(lightFill, white) < 4.5,
    "--accent is a fill token (~3.2:1 on white) and must not be used for small text",
  );
});

test("card helper text and chart ticks clear AA on the card plus its wash", () => {
  // Added 2026-10-21. Cards moved from `bg-background` to `bg-card` (#f4f7fa),
  // and CardWash lays bg-accent/[0.04] over that surface before the content
  // sits on it. slate-500, fine on white, fell to 4.43:1 on the bare card and
  // 4.25:1 through the wash, so both the secondary text pairing and the tick
  // token have to be pinned here or the next card restyle silently regresses.
  const light = themeBlock(":root");
  const card = hslToRgb(token(light, "card"));
  const washed = over(hslToRgb(token(light, "accent")), 0.04, card);

  const tick = contrast(hslToRgb(token(light, "muted")), washed);
  assert.ok(tick >= 4.5, `light chart tick on card + 4% wash is ${tick.toFixed(2)}:1, AA needs 4.5:1`);

  for (const dir of [join("app", "(dashboard)", "dashboard"), join("app", "demo")]) {
    const root = join(here, "..", dir);
    for (const rel of readdirSync(root, { recursive: true, encoding: "utf8" })) {
      if (!rel.endsWith(".tsx")) continue;
      const src = readFileSync(join(root, rel), "utf8");
      assert.ok(
        !src.includes("text-slate-500 dark:text-neutral-500"),
        `${join(dir, rel)}: card helper text needs text-slate-600 in light mode (slate-500 is 4.43:1 on bg-card)`,
      );
      assert.ok(
        !src.includes("text-slate-600 dark:text-neutral-500"),
        `${join(dir, rel)}: secondary text uses text-fg-muted (neutral-500 is 3.90:1 on the dark card)`,
      );
    }
  }
});

test("dark secondary text clears AA on the card and panel surfaces", () => {
  // Added 2026-10-21. dark:text-neutral-500 (#737373) on --card is 3.90:1,
  // below the 4.5:1 floor for small text. --fg-muted is the one token that
  // keeps light slate-600 and gives dark a tone that actually clears it.
  const light = themeBlock(":root");
  const dark = themeBlock(".dark");
  const lightInk = hslToRgb(token(light, "fg-muted"));
  const darkInk = hslToRgb(token(dark, "fg-muted"));
  const darkCard = hslToRgb(token(dark, "card"));
  const darkPanel = hslToRgb(token(dark, "panel"));

  for (const [label, bg] of [["card", darkCard], ["panel", darkPanel]] as const) {
    const ratio = contrast(darkInk, bg);
    assert.ok(ratio >= 4.5, `dark --fg-muted on --${label} is ${ratio.toFixed(2)}:1, AA needs 4.5:1`);
  }
  // Light must stay the class it replaced: slate-600, channel for channel.
  assert.deepEqual(
    lightInk.map((v) => Math.round(v * 255)),
    [69, 85, 108],
    "light --fg-muted must be Tailwind slate-600 (#45556c), or light mode shifts",
  );
});

test("chart tooltips use the theme tokens, not the Chart.js black default", () => {
  const theme = read(join("lib", "chart-theme.ts"));
  const chart = (name: string) => read(join("app", "(dashboard)", "dashboard", "_components", name));

  // The helper maps the same three tokens a DOM chip would use.
  assert.ok(theme.includes('surface: paint("--background")'), "tooltip surface reads --background");
  assert.ok(theme.includes('border: paint("--btn-border")'), "tooltip border reads --btn-border");
  assert.ok(theme.includes('ink: paint("--foreground")'), "tooltip text reads --foreground");
  assert.ok(theme.includes("backgroundColor: pal.surface"), "the helper applies the surface");
  assert.ok(theme.includes("titleColor: pal.ink"), "the helper applies the ink to the title");
  assert.ok(theme.includes("bodyColor: pal.ink"), "the helper applies the ink to the body");
  assert.ok(theme.includes("borderColor: pal.border"), "the helper applies the border");

  // And both charts must actually pass the options: a dropped `tooltip` key
  // silently restores the library default (black chip on a light dashboard).
  for (const name of ["PortsChartInner.tsx", "RiskTrendChartInner.tsx"]) {
    assert.ok(
      chart(name).includes("tooltip: chartTooltipOptions(pal)"),
      `${name} must theme its tooltip through chartTooltipOptions`,
    );
  }
});
