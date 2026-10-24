/**
 * The one piece of motion a dashboard card carries.
 *
 * A wash of the accent at a few percent opacity, breathing. `opacity` only -
 * it never repositions, resizes or reflows anything, because a card whose
 * *content* moves is a card that cannot be read while it is open. It sits
 * behind the card's own content (`absolute inset-0` with the card's own
 * background in front of it), is `aria-hidden`, and does not take pointer
 * events.
 *
 * Each instance takes its phase from the shared table in
 * `lib/motion-phases.ts`, so cards on the same page breathe out of step instead
 * of as one block.
 *
 * Gated at the use site with `motion-safe:` - under `prefers-reduced-motion`
 * this is a flat, static wash.
 */

import { phaseDelay } from "@/lib/motion-phases";

export default function CardWash({ index = 0 }: { index?: number }) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 bg-accent/[0.04] motion-safe:animate-ambient-pulse"
      style={{ animationDelay: phaseDelay(index, "pulse") }}
    />
  );
}
