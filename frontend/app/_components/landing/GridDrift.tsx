/**
 * A hairline grid that drifts, behind everything else.
 *
 * WHY A THIRD AMBIENT LAYER
 * -------------------------
 * The landing already carried a wash (`AmbientBackdrop`) and two accent washes
 * (`ParallaxField`), and both of them are soft - radial gradients with no edge
 * anywhere. A soft background reads as a glow, and a glow reads as decoration.
 * The grid is the layer that gives the page a measurable sense of place: once
 * there is a plane under the content, the sections are things *on* something
 * rather than bands of colour in a void.
 *
 * LINES, NOT DOTS
 * ---------------
 * `AmbientBackdrop` already drifts a dotted field, so a dot grid here would be
 * the same layer twice at a different scale. Lines at one density and dots at
 * another is a surface; dots twice is a pattern fighting itself.
 *
 * WHERE IT SITS AND HOW IT ENDS
 * ------------------------------
 * Rendered first inside the page-level `-z-10` stack, so it is the rearmost
 * layer - behind the wash, behind the parallax washes. The mask is what stops
 * it being a rectangle: the grid fades out toward the bottom of the viewport
 * instead of ending in a hard cut that would make the layer look like a panel
 * bolted on. `pointer-events-none` + `aria-hidden` because it carries no
 * information at all.
 *
 * The drift is the shared `grid` period from `lib/motion-phases.ts`, offset by
 * `phaseDelay` so it never moves in step with the dot grid behind... in front
 * of it. Under `prefers-reduced-motion` it is a static grid.
 */

import { phaseDelay } from "@/lib/motion-phases";

export default function GridDrift() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-[100dvh] overflow-hidden [mask-image:linear-gradient(to_bottom,black_58%,transparent)]"
    >
      <div
        className="absolute inset-0 bg-[linear-gradient(to_right,hsl(var(--foreground)/0.06)_1px,transparent_1px),linear-gradient(to_bottom,hsl(var(--foreground)/0.06)_1px,transparent_1px)] [background-size:64px_64px] motion-safe:animate-ambient-drift"
        style={{ animationDelay: phaseDelay(1, "grid") }}
      />
    </div>
  );
}
