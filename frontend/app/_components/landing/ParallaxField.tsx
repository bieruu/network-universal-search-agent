"use client";

import { useLayoutEffect, useState } from "react";
import { motion, useReducedMotion, useScroll, useTransform } from "motion/react";
import { phaseDelay } from "@/lib/motion-phases";

// Two accent washes that drift at different scroll speeds behind the hero.
// Decorative-only, transform-only (y), no backdrop softening - the static
// AmbientBackdrop underneath stays the no-JS/reduced-motion baseline.
//
// The resting pulse on each wash is offset through the shared phase table
// (`phaseDelay`), so the two washes never breathe on the same beat. Unoffset
// they rose and fell together, which made the whole backdrop read as one
// moving surface rather than two layers at different depths.
//
// HYDRATION (fix 2026-10-14). `useReducedMotion()` answers `null` on the
// server but `true` on a reduced-motion client at first render, so the old
// `if (reduce) return null` rendered a div in the server HTML and `null` in
// the client - a hydration mismatch that fired in reduce mode only, 4 of 4
// loads. The gate is now `mounted`: server and pre-mount client both render
// `null` (identical trees), and only after hydration does the real answer
// apply - reduce keeps `null`, normal motion renders the washes. The state
// flips in a layout effect so the washes appear before paint instead of
// popping in a frame late.
export default function ParallaxField() {
  const [mounted, setMounted] = useState(false);
  useLayoutEffect(() => {
    setMounted(true);
  }, []);
  const reduce = useReducedMotion();
  const { scrollY } = useScroll();
  const ySlow = useTransform(scrollY, [0, 800], [0, 70]);
  const yFast = useTransform(scrollY, [0, 800], [0, -50]);
  if (!mounted || reduce) return null;
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <motion.div
        style={{ y: ySlow, animationDelay: phaseDelay(0, "pulse") }}
        className="absolute -left-24 top-10 h-72 w-72 bg-[radial-gradient(circle,hsl(var(--accent)/0.13),transparent_65%)] motion-safe:animate-ambient-pulse"
      />
      <motion.div
        style={{ y: yFast, animationDelay: phaseDelay(1, "pulse") }}
        className="absolute -right-20 bottom-0 h-80 w-80 bg-[radial-gradient(circle,hsl(var(--accent)/0.1),transparent_65%)] motion-safe:animate-ambient-pulse"
      />
    </div>
  );
}
