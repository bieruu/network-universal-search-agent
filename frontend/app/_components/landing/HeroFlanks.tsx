"use client";

import Link from "next/link";
import { DEMO_SCANS } from "./playground-samples";
import { DEMO_REPORTS } from "../../demo/demo-report";
import { cn } from "@/lib/utils";

/**
 * The interactive panels flanking the hero globe at lg and up (operator,
 * 2026-10-16).
 *
 * WHY THESE AND NOT MORE DECORATION
 * ---------------------------------
 * A previous pass already dressed the band's empty flanks with washes, orbit
 * rings, an orbiting blip and limb ticks. The operator still called the
 * desktop hero too empty and asked, explicitly, for something INTERACTIVE on
 * the left and right of the globe. These two panels are that answer: three
 * example targets you can pick on the left, and an honest readout of the pick
 * on the right — the same fixtures `/demo` lays out as a full report.
 *
 * STATE FLOW
 * ----------
 * `Hero` owns `selected` (a target string or null) and passes it down as
 * `selected`/`onSelect`. `HeroGlobe` forwards both here and also uses
 * `selected` to emphasise the matching marker label on the sphere. One
 * selection, two surfaces, no local copy of the state.
 *
 * GEOMETRY (the constraints this layout was solved under)
 * -------------------------------------------------------
 * - lg and up ONLY (`hidden lg:block`): below lg the band is an overlay
 *   where the sphere fills the width and there is no side space at all.
 * - Both panels are absolutely positioned inside the band root, at its left
 *   and right edges, vertically centred, OUTSIDE the sphere's square wrapper
 *   (`lg:w-[22rem] xl:w-[24rem]`, centred). At exactly 1024px the band's
 *   content width is 976px, the sphere square spans x=312..664, the left
 *   panel (w-[13rem] = 208px) spans 0..208 and the right (w-[16rem] = 256px)
 *   spans 720..976 — both clear of the square by more than 50px. The widths
 *   are fixed rem for that reason: a fluid width could grow into the sphere.
 * - The band root keeps `pointer-events-none` (drag-to-spin must reach the
 *   canvas); only the real controls — the chip buttons and the two links —
 *   opt back in with `pointer-events-auto`. Nothing here ever covers the
 *   sphere, so no hit on a panel can be a hit the canvas expected.
 *
 * WHERE THE FACTS COME FROM
 * -------------------------
 * The readout renders fixture data and nothing else: the target name, the
 * sample's own output lines (source id + text, verbatim from
 * `playground-samples.ts` via `/demo`'s `buildDemoReport`), and the scripted
 * source failure — only `api.acme.co` has one (`errors: [{source: "nvd"}]`,
 * declared in `app/demo/demo-report.ts`). That file is imported, NOT copied:
 * a second hand-written error map here is exactly the drift trap both fixture
 * files were built to end, and it is also the only place that knows the
 * failure is simulated. No number is parsed, inferred or invented in this
 * file — a fact the fixture does not carry simply does not render. The
 * "Demo — simulated output" caption is the same wording `/demo` prints
 * (`DEMO_CAPTION` there, the playground's caption here), so a visitor never
 * mistakes the panel for a live scan.
 *
 * MOTION AND COLOUR
 * -----------------
 * Selection feedback is `transition-colors` only — no keyframe loops, no
 * entrance animation of its own (the band's `Reveal` in `Hero` covers the
 * entrance). Token colours throughout; zero hex literals (contract-tested).
 * Hover and focus use the same accent-wash + ring tokens the LogoStrip chips
 * settled on, so the two interactive strips on the landing page feel like one
 * control family.
 */
export default function HeroFlanks({
  selected,
  onSelect,
}: {
  /** The selected target name, or null for the resting state. */
  selected: string | null;
  /** Toggle handler: pass null to clear (clicking the active chip again). */
  onSelect: (target: string | null) => void;
}) {
  const report = selected
    ? DEMO_REPORTS.find((r) => r.target === selected) ?? null
    : null;

  return (
    <>
      {/* LEFT — "Example targets": the three shared demo targets as a
          single-select chip list. Toggle-off allowed: null is the resting
          state, and the globe label returns to its default style. */}
      <section
        aria-label="Example targets"
        className="pointer-events-none absolute left-0 top-1/2 hidden w-[13rem] -translate-y-1/2 lg:block"
      >
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-slate-500 dark:text-neutral-500">
          Example targets
        </p>
        <ul className="mt-2 space-y-1.5">
          {DEMO_SCANS.map(({ target }) => {
            const on = target === selected;
            return (
              <li key={target}>
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => onSelect(on ? null : target)}
                  className={cn(
                    "pointer-events-auto w-full rounded-full border px-3 py-1.5 text-left font-mono text-xs transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-accent/40",
                    on
                      ? "border-accent/60 bg-accent/10 text-accent"
                      : "border-neutral-200 text-slate-700 hover:border-accent/40 hover:bg-accent/5 hover:text-accent dark:border-neutral-800 dark:text-neutral-300",
                  )}
                >
                  {target}
                </button>
              </li>
            );
          })}
        </ul>
        <p className="mt-2 font-mono text-[10px] leading-relaxed text-slate-500 dark:text-neutral-500">
          Pick one — the globe lights up its point.
        </p>
      </section>

      {/* RIGHT — the readout. `aria-live` because the selection happens on
          the other side of the globe; without it a screen-reader user gets
          no news when this panel changes. */}
      <section
        aria-label="Selected target preview"
        aria-live="polite"
        className="pointer-events-none absolute right-0 top-1/2 hidden w-[16rem] -translate-y-1/2 lg:block"
      >
        {report ? (
          <div className="rounded-xl border border-neutral-200 bg-background/85 p-3 dark:border-neutral-800">
            <p className="font-mono text-xs font-semibold text-accent">
              {report.target}
            </p>
            {/* The sample's own output lines, verbatim: source id plus what
                that source reported. Nothing is re-worded or re-counted. */}
            <ul className="mt-2 space-y-1">
              {report.lines.map((line) => (
                <li
                  key={line.source}
                  className="break-words font-mono text-[10px] leading-snug text-slate-600 dark:text-neutral-300"
                >
                  <span className="text-slate-500 dark:text-neutral-500">
                    {line.source}
                  </span>{" "}
                  {line.says}
                </li>
              ))}
            </ul>
            {/* The scripted failure, if this target has one. The message is
                the fixture's own — it says "simulated" in words, and so does
                the caption below. */}
            {report.errors.length > 0 && (
              <p className="mt-2 rounded-lg border border-neutral-200 bg-panel p-2 font-mono text-[10px] leading-snug text-slate-600 dark:border-neutral-800 dark:text-neutral-300">
                {report.errors.map((e) => `${e.source} — ${e.message}`).join(" · ")}
              </p>
            )}
            <p className="mt-2 font-mono text-[10px] leading-relaxed text-slate-500 dark:text-neutral-500">
              Demo — simulated output, no live scan.
            </p>
            <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px]">
              <Link
                href="/demo"
                className="pointer-events-auto rounded-full transition-colors hover:text-accent focus:outline-none focus:ring-2 focus:ring-accent/40"
              >
                Open full demo report →
              </Link>
              <Link
                href="/dashboard"
                className="pointer-events-auto rounded-full transition-colors hover:text-accent focus:outline-none focus:ring-2 focus:ring-accent/40"
              >
                Open dashboard
              </Link>
            </p>
          </div>
        ) : (
          /* Resting state: the invitation. Same surface as the active panel
             so selecting does not shift the band's composition. */
          <p className="rounded-xl border border-neutral-200 bg-background/85 p-3 text-xs leading-relaxed text-slate-600 dark:border-neutral-800 dark:text-neutral-400">
            Pick a target on the left to preview its simulated report here —
            the globe lights up its point.
          </p>
        )}
      </section>
    </>
  );
}
