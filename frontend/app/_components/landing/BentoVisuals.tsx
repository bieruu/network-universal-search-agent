"use client";

import { motion, useReducedMotion } from "motion/react";

// Animated bento visuals: the port grid breathes via the shared ambient
// pulse (staggered delays, motion-safe), the metric bars grow on scroll
// into view (scaleY spring, transform-only). Static fallback when reduced
// motion is on.
const GRID_CELLS = [
  { tone: "bg-accent/30", delay: "0s" },
  { tone: "bg-slate-700", delay: "1.2s" },
  { tone: "bg-accent/20", delay: "2.4s" },
  { tone: "bg-slate-800", delay: "0.6s" },
  { tone: "bg-accent/35", delay: "1.8s" },
  { tone: "bg-slate-700", delay: "3s" },
] as const;

const BARS = [26, 34, 62, 48, 72, 58, 92] as const;

export function BentoGridVisual() {
  return (
    <div className="relative mt-4 grid h-36 grid-cols-3 gap-2 overflow-hidden rounded-xl border border-accent/15 bg-slate-900/95 p-2">
      {GRID_CELLS.map((c) => (
        <div
          key={`${c.tone}-${c.delay}`}
          className={`rounded-md ${c.tone} motion-safe:animate-ambient-pulse`}
          style={{ animationDelay: c.delay }}
        />
      ))}
      {/* Looping scanline: one highlight band sweeps across the port grid. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-accent/40 to-transparent motion-safe:animate-sweep" />
      </div>
    </div>
  );
}

export function BentoMetricsVisual() {
  const reduce = useReducedMotion();
  return (
    <div className="mt-4 flex h-36 items-end gap-2 rounded-xl border border-accent/15 bg-slate-900/95 p-3">
      {BARS.map((value, index) => {
        if (reduce)
          return (
            <div
              key={`${value}-${index}`}
              className="flex-1 rounded-t-md bg-gradient-to-t from-accent/70 to-emerald-300/90"
              style={{ height: `${value}px` }}
            />
          );
        return (
          <motion.div
            key={`${value}-${index}`}
            className="relative flex-1 origin-bottom"
            style={{ height: `${value}px` }}
            initial={{ scaleY: 0.2, opacity: 0.4 }}
            whileInView={{ scaleY: 1, opacity: 1 }}
            viewport={{ once: true, margin: "-40px" }}
            transition={{ type: "spring", stiffness: 120, damping: 18, delay: index * 0.06 }}
          >
            {/* Inner equalizer: each bar keeps breathing after it grows in. */}
            <div
              className="absolute inset-0 origin-bottom rounded-t-md bg-gradient-to-t from-accent/70 to-emerald-300/90 motion-safe:animate-eq"
              style={{ animationDelay: `${index * 0.18}s` }}
            />
          </motion.div>
        );
      })}
    </div>
  );
}
