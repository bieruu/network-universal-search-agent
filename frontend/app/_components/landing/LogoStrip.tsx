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
 * The bob was motion that informed nobody - it said "decoration" about records
 * that are the product's entire evidence base. The marks now sit still and
 * wait to be asked: click one and the panel below says what that source
 * actually contributes. That line is the product's evidence base made
 * findable, which is worth a deliberate tap rather than a drifting glyph.
 *
 * WHERE THE PANEL OPENS - SPLIT PER BREAKPOINT (2026-10-16, operator revision)
 * ----------------------------------------------------------------------------
 * The first fix for this section put the panel inline inside the active chip's
 * `li` (`basis-full`) at EVERY breakpoint. The operator reviewed it and said
 * the desktop result is untidy ("tidak rapih di tampilan desktop"): the four
 * chips stopped being one centered row and the panel wedged itself in the
 * middle of them. Their explicit wish: on desktop the panel opens below the
 * whole strip, on a phone it opens directly under the chip that was tapped.
 * So the placement is now split:
 *
 *   below `sm` - the active li becomes `basis-full` flex-column and renders
 *   the panel inline directly under its own button, so the chip and its
 *   dossier read as one block (the superseded design, kept where it works);
 *   `sm` and up - the li does NOT break the row and the panel renders once
 *   after the whole `<ul>`, where there is width for strip-plus-dossier.
 *
 * The single-row claim only holds once the column is wide enough for all four
 * chips. Measured, between `sm` (640px) and roughly 860px they wrap to two
 * centered rows while the panel still opens once below the whole strip; that
 * wrapping is ordinary flex-wrap, not the panel breaking the row.
 *
 * That means two render sites, gated so only one is ever visible: the inline
 * one is wrapped in `sm:hidden`, the after-`<ul>` one in `hidden sm:block`.
 * `display:none` removes the off-duty site from the accessibility tree, so
 * the copy is announced once - and BOTH sites render the same copy
 * expression (`active.gives`) via the local `panel()` helper, never duplicated
 * string literals (source-copy.ts stays the single source of truth).
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
 * monograms for sources without an icon - not a half-set of icons next to a
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
  //
  // Sizing: the box wraps the sentence (`w-fit`) instead of spanning its
  // wrapper, which is what it used to do - a 45-character line sat in a ~666px
  // slab and read as an empty card. `max-w-[65ch]` stays as the cap so a longer
  // sentence wraps at a readable measure rather than running wide, and
  // `mx-auto` keeps the now-narrower box centred in both wrappers, which are
  // full width (`w-full` inline below sm, block-level after the `<ul>` at sm+).
  //
  // Colour: light keeps slate-500 (4.55:1 on `bg-panel`, AA at 14px, and the
  // light look the operator approved). Dark moved neutral-500 -> neutral-400
  // on 2026-10-24: #737373 on the dark `--panel` measured 3.97:1, under the
  // 4.5:1 floor for normal text, while neutral-400 keeps the muted caption
  // tone. `text-fg-muted` was rejected only because its light value is
  // slate-600, which would visibly darken the approved light panel. The
  // chip's 12px sub-caption took the same neutral-500 -> neutral-400 move
  // for the same reason (12px is still "normal text" for AA).
  //
  // The sub-caption's light tone is the one place the chip's own background
  // matters, measured 2026-10-24 in the browser: idle on white slate-500 is
  // 4.76:1, but the SELECTED chip composites `bg-accent/10` over white to
  // #e5f5f0, where slate-500 falls to 4.26:1 - under AA, exactly when the
  // caption is read. So selected switches to slate-600 (6.74:1 on that
  // #e5f5f0) while dark keeps neutral-400 in both states (6.29:1 selected,
  // 7.45:1 idle on the dark chip).
  const panel = (gating: string) =>
    active && (
      <Reveal className={gating}>
        <div className="mx-auto w-fit max-w-[65ch] rounded-xl border border-neutral-200 bg-panel p-4 dark:border-neutral-800">
          <p className="text-sm leading-relaxed text-slate-500 dark:text-neutral-400">
            {active.gives}
          </p>
        </div>
      </Reveal>
    );

  return (
    <section
      aria-label="What each source gives you"
      className="border-y border-btn-border"
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
                    // header), so the chips share a row and wrap only when the
                    // column cannot fit all four.
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
                      ? "border-accent/60 bg-accent/10 text-accent-text"
                      : "border-neutral-200 text-slate-700 hover:border-accent/40 hover:bg-accent/5 hover:text-accent-text dark:border-neutral-800 dark:text-neutral-300",
                  )}
                >
                  {s.mark}
                  <span
                    className={cn(
                      "text-xs dark:text-neutral-400",
                      on ? "text-slate-600" : "text-slate-500",
                    )}
                  >
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
        {/* sm and up: the panel opens once below the strip, centered under
            the whole strip; the chips themselves wrap until they fit. */}
        {panel("mt-4 hidden sm:block")}
      </div>
    </section>
  );
}
