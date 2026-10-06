"use client";

import { motion, useReducedMotion, useScroll, useTransform } from "motion/react";

// Two accent washes that drift at different scroll speeds behind the hero.
// Decorative-only, transform-only (y), no backdrop softening — the static
// AmbientBackdrop underneath stays the no-JS/reduced-motion baseline.
export default function ParallaxField() {
  const reduce = useReducedMotion();
  const { scrollY } = useScroll();
  const ySlow = useTransform(scrollY, [0, 800], [0, 70]);
  const yFast = useTransform(scrollY, [0, 800], [0, -50]);
  if (reduce) return null;
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <motion.div
        style={{ y: ySlow }}
        className="absolute -left-24 top-10 h-72 w-72 bg-[radial-gradient(circle,rgba(0,229,155,0.13),transparent_65%)] motion-safe:animate-ambient-pulse"
      />
      <motion.div
        style={{ y: yFast }}
        className="absolute -right-20 bottom-0 h-80 w-80 bg-[radial-gradient(circle,rgba(0,229,155,0.1),transparent_65%)] motion-safe:animate-ambient-pulse"
      />
    </div>
  );
}
