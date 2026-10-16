"use client";

import { useLayoutEffect, useState } from "react";
import { motion, useReducedMotion, useScroll, useSpring } from "motion/react";

// Thin scroll progress bar pinned to the top of the sticky nav.
// Transform-only (scaleX), spring-smoothed, hidden when reduced motion is on.
//
// HYDRATION (same fix as ParallaxField, 2026-10-14). `useReducedMotion()`
// answers `null` on the server but `true` on a reduced-motion client at first
// render, so `if (reduce) return null` rendered the bar in the server HTML and
// nothing on the client — a hydration mismatch that fired in reduce mode only
// (it became visible only after ParallaxField's identical bug was fixed; both
// were the same defect). The gate is now `mounted`: server and pre-mount client
// both render `null` (identical trees), and only after hydration does the real
// answer apply. The state flips in a layout effect so the bar appears before
// paint instead of a frame late.
export default function ScrollProgress() {
  const [mounted, setMounted] = useState(false);
  useLayoutEffect(() => {
    setMounted(true);
  }, []);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll();
  const scaleX = useSpring(scrollYProgress, { stiffness: 120, damping: 24, mass: 0.4 });
  if (!mounted || reduce) return null;
  return (
    <motion.div
      aria-hidden="true"
      style={{ scaleX }}
      className="absolute inset-x-0 top-0 h-0.5 origin-left bg-accent"
    />
  );
}
