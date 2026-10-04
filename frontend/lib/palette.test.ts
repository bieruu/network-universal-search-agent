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

test("shared tokens exist in light and dark themes", () => {
  for (const token of ["--background", "--foreground", "--accent", "--accent-foreground", "--accent-hover", "--muted", "--warning", "--danger", "--panel"]) {
    assert.ok(css.includes(token), `globals.css must define ${token}`);
  }
  assert.ok(css.includes("--background: 210 33% 6%"), "dark background is neutral #0a0f14, not blue");
  for (const color of ["accent", "accent-foreground", "accent-hover", "muted", "warning", "danger", "panel"]) {
    assert.ok(css.includes(`--color-${color}:`), `Tailwind theme must map ${color}`);
  }
  assert.ok(css.includes('@custom-variant dark (&:where(.dark, .dark *))'), "dark utilities follow the html class");
  assert.ok(css.includes("--font-mono:"), "custom mono font utility remains available");
  assert.ok(css.includes("--shadow-input:"), "custom input shadow utility remains available");
  assert.ok(css.includes("--animate-ripple:"), "custom animations remain available");
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
  assert.ok(authShell.includes("dark:bg-[#0a0f14]"), "auth dark keeps the reference surface");
  assert.ok(!/(?<!dark:)bg-\[#0a0f14\]/.test(authShell.replaceAll("dark:bg-[#0a0f14]", "")), "no light-mode #0a0f14 leak");
  assert.ok(authShell.includes("text-slate-900 dark:text-neutral-100"), "headings pair light/dark");
  assert.ok(authShell.includes("text-accent"), "emerald text uses the global accent token");
  assert.ok(authShell.includes("bg-accent"), "emerald fills use the global accent token");
  assert.ok(!authShell.includes("00E59B"), "no hardcoded emerald hex in auth shell");
  assert.ok(signup.includes("AuthShell"), "sign-up shares the auth shell");
});

test("landing sections pair light/dark text, borders and surfaces", () => {
  for (const [f, src] of Object.entries(landing)) {
    assert.ok(!src.includes("text-neutral-50\"") || src.includes("dark:text-neutral-50"), `${f}: neutral-50 must be dark-paired`);
    const noUrls = src.replace(/https:\/\/cdn\.simpleicons\.org\/\S+/g, "");
    assert.ok(!noUrls.includes("00E59B"), `${f}: no hardcoded emerald hex — use *-accent utilities (CDN icon URLs excepted)`);
  }
  assert.ok(landingAll.includes("border-neutral-200"), "light borders exist");
  assert.ok(landingAll.includes("dark:border-neutral-800"), "dark borders kept");
  assert.ok(landingAll.includes("text-slate-900 dark:text-neutral-50"), "headings pair light/dark");
  assert.ok(landing["HowItWorks.tsx"].includes("bg-slate-50"), "how-it-works has a light surface");
  assert.ok(landing["HowItWorks.tsx"].includes("dark:bg-[#0c1117]"), "how-it-works keeps dark surface");
  assert.ok(landing["Hero.tsx"].includes("bg-panel"), "terminal uses the shared panel token");
  assert.ok(landing["FeatureBento.tsx"].includes("bg-panel"), "bento matches the terminal surface");
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
  assert.ok(sidebar.includes("tracking-widest text-accent"), "sidebar Sources header is an accent mono eyebrow");
  assert.ok(sidebar.includes("bg-accent/10 font-mono"), "source monogram chips use the accent wash");
  assert.ok(!sidebar.includes("bg-input"), "no flat monochrome input surface left in the sidebar");
});
