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
              <li key={s.mark}>
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
              </li>
            );
          })}
        </ul>
        {active && (
          <Reveal>
            <div className="mx-auto mt-4 max-w-[65ch] rounded-xl border border-neutral-200 bg-panel p-4 dark:border-neutral-800">
              <p className="text-sm leading-relaxed text-slate-700 dark:text-neutral-300">
                {active.gives}
              </p>
              <p className="mt-2 text-xs leading-relaxed text-slate-500 dark:text-neutral-500">
                {active.whenSlow}
              </p>
            </div>
          </Reveal>
        )}
      </div>
    </section>
  );
}
