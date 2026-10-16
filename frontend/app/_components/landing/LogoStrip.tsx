"use client";

import { useState } from "react";
import Reveal from "./Reveal";
import { SOURCES } from "./source-copy";
import { cn } from "@/lib/utils";

/**
 * Where every answer comes from, as chips that answer back.
 *
 * WHY THIS IS INTERACTIVE AND NOT A STRIP
 * ---------------------------------------
 * These four sources used to be a static row of names that bobbed in a loop.
 * The bob was motion that informed nobody — it said "decoration" about records
 * that are the product's entire evidence base. The marks now sit still and
 * wait to be asked: click one and the panel below says what that source
 * actually contributes and what the rest of the result looks like when it is
 * slow or unreachable. That second half is the product's core honest claim
 * ("a gap is never mistaken for good news", see FeatureBento), so it is the
 * thing worth making findable rather than something to imply with a drifting
 * glyph.
 *
 * WHERE THE PANEL OPENS — SPLIT PER BREAKPOINT (2026-10-16, operator revision)
 * ----------------------------------------------------------------------------
 * The first fix for this section put the panel inline inside the active chip's
 * `li` (`basis-full`) at EVERY breakpoint. The operator reviewed it and said
 * the desktop result is untidy ("tidak rapih di tampilan desktop"): the four
 * chips stopped being one centered row and the panel wedged itself in the
 * middle of them. Their explicit wish: on desktop the panel opens below the
 * whole strip, on a phone it opens directly under the chip that was tapped.
 * So the placement is now split:
 *
 *   below `sm` — the active li becomes `basis-full` flex-column and renders
 *   the panel inline directly under its own button, so the chip and its
 *   dossier read as one block (the superseded design, kept where it works);
 *   `sm` and up — the li does NOT break the row (chips stay one centered row
 *   as before the first fix) and the panel renders once after the whole
 *   `<ul>`, where there is width for strip-plus-dossier.
 *
 * That means two render sites, gated so only one is ever visible: the inline
 * one is wrapped in `sm:hidden`, the after-`<ul>` one in `hidden sm:block`.
 * `display:none` removes the off-duty site from the accessibility tree, so
 * the copy is announced once — and BOTH sites render the same copy
 * expressions (`active.gives`, `active.whenSlow`) via the local `panel()`
 * helper, never duplicated string literals (source-copy.ts stays the single
 * source of truth).
 *
 * The li's class conflict is resolved by Tailwind v4's cascade, not by
 * `cn()` (which here is a plain join, no tailwind-merge): the `sm:` overrides
 * live in a min-width media query that the generated stylesheet emits after
 * the base utilities, so `sm:basis-auto sm:flex-row` deterministically beat
 * `basis-full flex-col` at `sm`+.
 *
 * WHY NOT A LOGO WALL
 * -------------------
 * Shodan and crt.sh have no Simple Icons marks, and DESIGN.md's rule is mono
 * monograms for sources without an icon — not a half-set of icons next to a
 * half-set of monograms. The mono name IS the mark; it already carried the
 * strip before and it reads correctly at this size in both themes.
 */

export default function LogoStrip() {
  // One selection at a time. `null` is the resting state: the section reads
  // exactly like the static strip did until someone asks a question.
  const [selected, setSelected] = useState<string | null>(null);
  const active = SOURCES.find((s) => s.mark === selected) ?? null;

  // One markup definition, two gated render sites (see header): `gating`
  // carries the breakpoint visibility classes. Copy always comes from
  // source-copy.ts via `active`, so the two sites cannot drift.
  const panel = (gating: string) =>
    active && (
      <Reveal className={gating}>
        <div className="mx-auto max-w-[65ch] rounded-xl border border-neutral-200 bg-panel p-4 dark:border-neutral-800">
          <p className="text-sm leading-relaxed text-slate-700 dark:text-neutral-300">
            {active.gives}
          </p>
          <p className="mt-2 text-xs leading-relaxed text-slate-500 dark:text-neutral-500">
            {active.whenSlow}
          </p>
        </div>
      </Reveal>
    );

  return (
    <section
      aria-label="Public records these results are drawn from"
      className="border-y border-neutral-200 dark:border-neutral-800/80"
    >
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        <ul className="flex flex-wrap items-center justify-center gap-2">
          {SOURCES.map((s) => {
            const on = s.mark === selected;
            return (
              <li
                key={s.mark}
                className={cn(
                  on &&
                    // Mobile-first: full-width column, panel directly under its
                    // own chip. At `sm`+ the overrides restore chip-size row
                    // layout (they win via the media-query cascade, see
                    // header), so the strip stays one centered line.
                    "flex basis-full flex-col items-center gap-3 sm:basis-auto sm:flex-row",
                )}
              >
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => setSelected(on ? null : s.mark)}
                  className={cn(
                    "flex items-baseline gap-2 rounded-full border px-3.5 py-1.5 font-mono text-sm transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-accent/40",
                    on
                      ? "border-accent/60 bg-accent/10 text-accent"
                      : "border-neutral-200 text-slate-700 hover:border-accent/40 hover:bg-accent/5 hover:text-accent dark:border-neutral-800 dark:text-neutral-300",
                  )}
                >
                  {s.mark}
                  <span className="text-xs text-slate-500 dark:text-neutral-500">
                    {s.detail}
                  </span>
                </button>
                {/* Below sm the panel belongs to THIS chip and opens right
                    under it; at sm+ this site is display:none (out of the
                    accessibility tree) and the after-<ul> site takes over.
                    The li's items-center keeps the button shrink-to-fit; the
                    panel is mx-auto + max-w-[65ch]. */}
                {on && panel("w-full sm:hidden")}
              </li>
            );
          })}
        </ul>
        {/* sm and up: the strip stays one centered row and the panel opens
            once below it, centered under the whole strip. */}
        {panel("mt-4 hidden sm:block")}
      </div>
    </section>
  );
}
