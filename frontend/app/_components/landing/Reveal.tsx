"use client";

import { motion, useReducedMotion } from "motion/react";
import { useLayoutEffect, useState, type ReactNode } from "react";

// transform + opacity only; collapses to static when reduced motion is on.
//
// HYDRATION (fix 2026-10-14). `useReducedMotion()` is `null` on the server
// but `true` on a reduced-motion client at first render, so `if (reduce)`
// swapped the `motion.div` for a bare `<div>` during hydration and React
// bailed out. The static branch now waits for `mounted`: server and pre-mount
// client both render the same `motion.div` tree, and the layout effect flips
// it to the bare `<div>` before paint once hydration is done.
export default function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const [mounted, setMounted] = useState(false);
  useLayoutEffect(() => {
    setMounted(true);
  }, []);
  const reduce = useReducedMotion();
  if (mounted && reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ type: "spring", stiffness: 100, damping: 20, delay }}
    >
      {children}
    </motion.div>
  );
}
