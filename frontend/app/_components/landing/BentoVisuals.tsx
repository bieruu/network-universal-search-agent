"use client";

import { motion, useReducedMotion } from "motion/react";
import { useLayoutEffect, useState } from "react";
import { phaseDelay } from "@/lib/motion-phases";
import { demoSampleMetrics } from "./playground-samples";

// Bento visuals. Both cells now read the SAME figures the terminal prints:
// open-port counts in the grid, certificate-name counts in the bars, taken from
// `playground-samples.ts` via `demoSampleMetrics()`. The earlier versions
// carried their own hand-written arrays that only looked like those figures —
// a second set of numbers for one sample is how a visual ends up disagreeing
// with the output it sits under, and it is now impossible by construction.
//
// Every figure is still simulated (see the header of playground-samples.ts).
// Nothing here is a claim about any real host.

/** One cell per port reported for that sample, capped so the grid cannot grow
 *  without limit if a sample ever reports a large number. */
const PORT_CELL_CAP = 12;

/** Pixels per unit of bar height, so a count maps to one scale and not three. */
const NAMES_PER_PX = 6;

const ROWS = demoSampleMetrics();

export function BentoGridVisual() {
  return (
    <div className="relative mt-4 h-36 overflow-hidden rounded-xl border border-accent/15 bg-slate-900/95 p-2">
      {/* Centered with a fixed gap instead of justify-between: distributing
          three ~16px rows across the h-36 slack floated them ~68px apart, so
          they read as satellites rather than one list. 3 rows + 2 × 8px gaps ≈
          64px centered in the 128px content box → symmetric air, grouped rows.
          h-36 stays (parity with BentoMetricsVisual as a system). */}
      <div className="flex h-full flex-col justify-center gap-2">
        {ROWS.map(({ sample, metrics }, row) => (
          <div key={sample.target} className="flex min-w-0 items-center gap-2">
            <span className="w-24 shrink-0 truncate font-mono text-[10px] text-slate-400">
              {sample.target}
            </span>
            <span className="flex min-w-0 flex-1 flex-wrap gap-1">
              {metrics.ports == null ? (
                // The sample stopped reporting a count. Saying nothing is the
                // only honest option: a row of invented cells would be a made-up
                // number, and an empty row would read as zero open ports.
                <span className="font-mono text-[10px] text-slate-500">
                  no port count reported
                </span>
              ) : (
                Array.from({ length: Math.min(metrics.ports, PORT_CELL_CAP) }).map((_, cell) => (
                  <span
                    key={cell}
                    className="h-2.5 w-2.5 rounded-sm bg-accent/40 motion-safe:animate-ambient-pulse"
                    style={{ animationDelay: phaseDelay(row * PORT_CELL_CAP + cell, "pulse") }}
                  />
                ))
              )}
            </span>
          </div>
        ))}
      </div>
      {/* Looping scanline: one highlight band sweeps across the port grid. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-accent/40 to-transparent motion-safe:animate-sweep" />
      </div>
    </div>
  );
}

export function BentoMetricsVisual() {
  // HYDRATION (fix 2026-10-14): the static `reduce` branch replaced the
  // motion.div bars with bare divs during hydration on reduced-motion
  // clients (the hook answers `null` server-side, `true` client-side).
  // `mounted` keeps server and first client render on the motion branch;
  // the layout effect swaps to the static bars before paint.
  const [mounted, setMounted] = useState(false);
  useLayoutEffect(() => {
    setMounted(true);
  }, []);
  const reduce = useReducedMotion();
  return (
    <div className="mt-4 flex h-36 items-end gap-3 rounded-xl border border-accent/15 bg-slate-900/95 p-3">
      {ROWS.map(({ sample, metrics }, index) => {
        const names = metrics.certNames;
        // Same fallback as the grid: no figure means no bar, never a bar of an
        // invented height, because a zero-height bar reads as "none found".
        if (names == null) {
          return (
            <div key={sample.target} className="flex h-full flex-1 items-end">
              <span className="font-mono text-[10px] leading-tight text-slate-500">
                {sample.target}
                <br />
                no count reported
              </span>
            </div>
          );
        }
        const height = Math.max(names * NAMES_PER_PX, 8);
        if (mounted && reduce)
          return (
            <div key={sample.target} className="flex h-full flex-1 flex-col justify-end gap-1">
              <div
                className="w-full rounded-t-md bg-gradient-to-t from-accent/70 to-emerald-300/90"
                style={{ height: `${height}px` }}
              />
              <span className="truncate font-mono text-[10px] text-slate-400">{names}</span>
            </div>
          );
        return (
          <div key={sample.target} className="flex h-full flex-1 flex-col justify-end gap-1">
            <motion.div
              className="relative w-full origin-bottom"
              style={{ height: `${height}px` }}
              initial={{ scaleY: 0.2, opacity: 0.4 }}
              whileInView={{ scaleY: 1, opacity: 1 }}
              viewport={{ once: true, margin: "-40px" }}
              transition={{ type: "spring", stiffness: 120, damping: 18, delay: index * 0.06 }}
            >
              {/* Inner equalizer: each bar keeps breathing after it grows in. */}
              <div
                className="absolute inset-0 origin-bottom rounded-t-md bg-gradient-to-t from-accent/70 to-emerald-300/90 motion-safe:animate-eq"
                style={{ animationDelay: phaseDelay(index, "eq") }}
              />
            </motion.div>
            <span className="truncate font-mono text-[10px] text-slate-400">{names}</span>
          </div>
        );
      })}
    </div>
  );
}
