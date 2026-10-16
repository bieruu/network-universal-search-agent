"use client";

import { motion, useReducedMotion } from "motion/react";
import { useLayoutEffect, useState } from "react";

// Risk bar that fills (scaleX spring, transform-only) when scrolled into
// view. Static one-third fill when reduced motion is on.
//
// HYDRATION (fix 2026-10-14): `reduce` is `null` on the server but `true`
// on a reduced-motion client at first render, so the two branches produced
// different DOM mid-hydration. The static branch waits for `mounted`, so
// server and first client render both take the motion branch.
export default function RiskMeter() {
  const [mounted, setMounted] = useState(false);
  useLayoutEffect(() => {
    setMounted(true);
  }, []);
  const reduce = useReducedMotion();
  return (
    <div className="relative h-full w-full overflow-hidden rounded-full">
      {mounted && reduce ? (
        <div className="h-full w-1/3 rounded-full bg-gradient-to-r from-emerald-400 to-accent" />
      ) : (
        <motion.div
          aria-hidden="true"
          className="absolute inset-0 origin-left rounded-full bg-gradient-to-r from-emerald-400 to-accent"
          initial={{ scaleX: 0 }}
          whileInView={{ scaleX: 0.33 }}
          viewport={{ once: true, margin: "-40px" }}
          transition={{ type: "spring", stiffness: 60, damping: 20 }}
        />
      )}
      {/* Looping shimmer band across the filled portion. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="absolute inset-y-0 w-1/4 bg-gradient-to-r from-transparent via-white/30 to-transparent motion-safe:animate-sweep" />
      </div>
    </div>
  );
}
