"use client";

import { phaseDelay } from "@/lib/motion-phases";

/**
 * The dashboard's ambient layer: a wash and a hairline grid behind the shell.
 *
 * WHY THE DASHBOARD HAS ONE AT ALL
 * --------------------------------
 * This route used to be contractually motionless — `lib/dashboard.test.ts`
 * carried a test named `dashboard data surfaces stay static — ambient motion is
 * landing/auth only`, and DESIGN.md recorded the reason: *"a moving row next to
 * a result being read is a row that cannot be trusted to hold still"*.
 *
 * That reason was right and still is, which is why this layer obeys it exactly:
 * it is **behind** everything (`-z-10`), decorative (`aria-hidden`,
 * `pointer-events-none`), and it animates only the plane the content sits on.
 * Nothing that carries a value moves — not a table row, not a number, not a
 * banner. The lock was reversed on 2026-10-12 because a console whose whole
 * surface is dead reads as a page that failed to load, not as a page that is
 * resting; and it was reversed *without* dropping the rule that motivated it.
 * See DESIGN.md (reversal note) and the two floors in `lib/loop-contract.test.ts`.
 *
 * WHY IT IS NOT A COPY OF THE LANDING LAYER
 * -----------------------------------------
 * The landing backdrop is sized to the viewport and fades out at the bottom,
 * because it sits behind a hero. Here it covers the whole scrollable shell, so
 * the mask fade is vertical across the document's own height rather than one
 * viewport, and the grid is denser: a console is read for longer and needs a
 * tighter plane to keep sections separate without adding borders everywhere.
 *
 * The two layers take their periods from the shared table in
 * `lib/motion-phases.ts` and are offset against each other, so the wash and the
 * grid never breathe on the same beat.
 */
export default function AmbientLayer() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden [mask-image:linear-gradient(to_bottom,black_62%,transparent)]"
    >
      <div
        className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(0,229,155,0.08),transparent_58%)] motion-safe:animate-ambient-pulse dark:bg-[radial-gradient(circle_at_50%_0%,rgba(0,229,155,0.11),transparent_58%)]"
        style={{ animationDelay: phaseDelay(0, "pulse") }}
      />
      <div
        className="absolute inset-0 bg-[linear-gradient(to_right,rgba(15,23,42,0.045)_1px,transparent_1px),linear-gradient(to_bottom,rgba(15,23,42,0.045)_1px,transparent_1px)] [background-size:56px_56px] motion-safe:animate-ambient-drift dark:bg-[linear-gradient(to_right,rgba(255,255,255,0.04)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.04)_1px,transparent_1px)]"
        style={{ animationDelay: phaseDelay(1, "grid") }}
      />
    </div>
  );
}
