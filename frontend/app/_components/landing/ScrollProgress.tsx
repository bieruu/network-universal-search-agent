"use client";

import { motion, useReducedMotion, useScroll, useSpring } from "motion/react";

// Thin scroll progress bar pinned to the top of the sticky nav.
// Transform-only (scaleX), spring-smoothed, hidden when reduced motion is on.
export default function ScrollProgress() {
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll();
  const scaleX = useSpring(scrollYProgress, { stiffness: 120, damping: 24, mass: 0.4 });
  if (reduce) return null;
  return (
    <motion.div
      aria-hidden="true"
      style={{ scaleX }}
      className="absolute inset-x-0 top-0 h-0.5 origin-left bg-accent"
    />
  );
}
