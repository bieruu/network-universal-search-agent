/**
 * The one table of motion periods every layer in this app reads from.
 *
 * WHY THIS FILE EXISTS
 * -------------------
 * Delays and durations used to be hardcoded per file: `animationDelay: "1.5s"`
 * in one section, `"0.6s"` in another, `14s` in `globals.css` and `2.4s` again
 * in the same file. Nothing was wrong with any single number. What was wrong
 * was that they were handed out independently, so nothing could keep two
 * sections from landing on the same beat — and when every loop on a page
 * breathes at the same moment, the page reads as one block of motion instead
 * of several independent surfaces. It also means a "slow everything down"
 * pass is eight edits in six files.
 *
 * So: one table, and every consumer — the CSS custom properties in
 * `app/globals.css` and every `animationDelay` in the source — must derive its
 * number from here. `phaseDeclarations()` emits the `--animate-*` lines for the
 * stylesheet, and a contract test asserts those exact lines are the ones the
 * stylesheet carries, so the two cannot drift apart the way old inline numbers
 * did.
 *
 * WHY THESE NUMBERS
 * -----------------
 * The five long periods are separated from their nearest neighbour by at least
 * a factor of one and a half (52 / 26 / 14 / 9 / 5). Two loops whose periods are
 * close but not equal still re-converge every few seconds, which is the same
 * visual problem wearing a disguise. The short ones (`blip` .. `breathe`) are the
 * local micro-loops: fast enough to read as "this thing is live", slow enough
 * not to flicker.
 *
 * NOTHING HERE IS A GATE
 * ----------------------
 * Reducing motion is `motion-safe:` / `useReducedMotion()` — this file only
 * decides how fast. A layer that must stop must still be gated at its use site.
 */

/** Long, section-level periods, in seconds. */
export const MOTION_PHASES = {
  /** The slowest layer: full-bleed washes behind everything. */
  wash: 26,
  /** Hairline grid drift. */
  grid: 14,
  /** Section-local drift (a panel, a card bed). */
  drift: 9,
  /** Cards, cells and resting dots. */
  pulse: 5,
  /**
   * Slow scene rotation: the hero globe (`HeroGlobe.tsx`). It used to also
   * drive the ambient 3D scenes — the hero node graph and the dashboard
   * sphere — both removed 2026-10-14 when the globe became the hero's picture.
   * The entry stays in the table because the globe still reads it, and
   * `lib/loop-contract.test.ts` pins the range: a revolution, not a spin.
   */
  globe: 52,
} as const;

/**
 * Short, local micro-phases, in seconds.
 *
 * Most of these are loops, but the table's rule is about *inventing numbers*,
 * not about repetition: a duration may not appear at a use site whether it
 * repeats or plays once. So the burger sheet's one-shot open/close pair lives
 * here too, and `PHASE_CSS` declares it with `iterations: "1"` instead of the
 * default `infinite`.
 */
export const MICRO_PHASES = {
  /** Scanline / shimmer sweep. */
  sweep: 2.4,
  /** Live-status blip. */
  blip: 1.3,
  /** Equalizer bars. */
  eq: 1.6,
  /** CTA halo. */
  breathe: 2.6,
  /** Burger sheet opening: panel in from its own edge, scrim up with it. */
  sheetIn: 0.2,
  /**
   * Burger sheet closing. Shorter than the open — leaving should feel quicker
   * than arriving, and an exit that lingers reads as the page hesitating.
   */
  sheetOut: 0.14,
} as const;

export type MotionPhase = keyof typeof MOTION_PHASES;
export type MicroPhase = keyof typeof MICRO_PHASES;

/** Every period this project declares, in one map. */
export const PHASE_SECONDS: Readonly<Record<MotionPhase | MicroPhase, number>> = {
  ...MOTION_PHASES,
  ...MICRO_PHASES,
};

export type PhaseName = keyof typeof PHASE_SECONDS;

/**
 * Golden-ratio offset. Successive elements land as far from the previous ones
 * as an irrational step allows, so a list of loops spreads across its period
 * instead of clumping at a few round numbers — which is exactly the clumping
 * that made sections read as one block.
 */
const GOLDEN = 0.618033988749895;

/**
 * An `animationDelay` for the `index`-th element of a `phase` loop, derived
 * from the shared table rather than written out by hand.
 *
 * Always positive and always shorter than the period, so it never delays an
 * element past its own cycle (a delay ≥ period is a phase shift that looks
 * like a bug, and it stops the element from starting where its neighbours do).
 */
export function phaseDelay(index: number, phase: PhaseName): string {
  const seconds = PHASE_SECONDS[phase];
  // `index + 1` so element 0 is not offset by exactly zero: two elements
  // starting together is the case the whole table exists to avoid.
  const offset = (((index + 1) * GOLDEN) % 1) * seconds;
  return `${Number(offset.toFixed(2))}s`;
}

interface PhaseCss {
  /** CSS custom property, e.g. `--animate-sweep`. */
  property: string;
  /** `@keyframes` name it drives. */
  keyframes: string;
  phase: PhaseName;
  easing: string;
  iterations?: string;
}

const PHASE_CSS: readonly PhaseCss[] = [
  { property: "--animate-ambient-drift", keyframes: "ambient-drift", phase: "grid", easing: "ease-in-out" },
  { property: "--animate-ambient-pulse", keyframes: "ambient-pulse", phase: "pulse", easing: "ease-in-out" },
  { property: "--animate-sweep", keyframes: "sweep", phase: "sweep", easing: "linear" },
  { property: "--animate-blip", keyframes: "blip", phase: "blip", easing: "ease-in-out" },
  { property: "--animate-eq", keyframes: "eq", phase: "eq", easing: "ease-in-out" },
  { property: "--animate-breathe", keyframes: "breathe", phase: "breathe", easing: "ease-in-out" },
  // The burger sheet and its scrim (components/ui/sheet.tsx). One-shot, so
  // `iterations: "1"` rather than the default infinite. All four share one
  // curve because panel and scrim are one event: a scrim fading on a different
  // beat from the panel in front of it reads as two unrelated things happening
  // (AGENTS.md §6 — the overlay moves with the sheet). `cubic-bezier(0.32,0.72,0,1)`
  // is the drawer curve: quick off the mark, long settle.
  { property: "--animate-sheet-in", keyframes: "sheet-in", phase: "sheetIn", easing: "cubic-bezier(0.32,0.72,0,1)", iterations: "1" },
  { property: "--animate-sheet-out", keyframes: "sheet-out", phase: "sheetOut", easing: "cubic-bezier(0.32,0.72,0,1)", iterations: "1" },
  { property: "--animate-overlay-in", keyframes: "overlay-in", phase: "sheetIn", easing: "cubic-bezier(0.32,0.72,0,1)", iterations: "1" },
  { property: "--animate-overlay-out", keyframes: "overlay-out", phase: "sheetOut", easing: "cubic-bezier(0.32,0.72,0,1)", iterations: "1" },
];

/**
 * The `--animate-*` declarations `app/globals.css` must carry, generated from
 * the table above.
 *
 * `app/globals.css` cannot import this module — it is plain CSS — so the numbers
 * live here and the stylesheet mirrors them, and
 * `lib/loop-contract.test.ts` asserts that the mirrored declarations are
 * byte-identical to what this function returns. That is the drift guard: the
 * period in a comment and the period in the stylesheet are two claims, and this
 * is what keeps them the same claim.
 */
export function phaseDeclarations(): string[] {
  return PHASE_CSS.map(
    ({ property, keyframes, phase, easing, iterations = "infinite" }) =>
      `${property}: ${keyframes} ${PHASE_SECONDS[phase]}s ${easing} ${iterations};`,
  );
}
