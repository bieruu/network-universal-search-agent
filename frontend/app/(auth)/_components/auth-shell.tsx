"use client";

import type { ReactNode } from "react";
import { useLayoutEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { DEMO_SCANS } from "@/app/_components/landing/playground-samples";

// HYDRATION (2026-10-14, same fix as ParallaxField/ScrollProgress).
// `useReducedMotion()` answers `null` on the server but `true` on a
// reduced-motion client at first render, so every pre-mount branch on it -
// here, the local Reveal's `<div>` vs `motion.div` and the two decorative
// spans below - mismatches the server HTML in reduce mode. The gate is now
// `mounted`: server and pre-mount client render the same tree, and the real
// answer applies after a layout-effect mount, before paint.
function Reveal({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  const [mounted, setMounted] = useState(false);
  useLayoutEffect(() => {
    setMounted(true);
  }, []);
  const reduce = useReducedMotion();
  if (!mounted || reduce) return <div>{children}</div>;
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 100, damping: 20, delay }}
    >
      {children}
    </motion.div>
  );
}

/**
 * The left panel used to be an orbit: nine lucide icons on two counter-rotating
 * rings around the monogram, plus a radial glow, plus dotted graph paper. It is
 * the signature move of the "modern animated sign-in" template, and it said
 * nothing at all about this product - nine generic glyphs orbiting a letter is
 * decoration that costs 9 icons, 2 rings and 3 keyframes to say "login".
 *
 * What replaced it does one job: it shows the product's own output. The panel
 * prints a real sample transcript - the same one the landing hero replays, read
 * from `playground-samples.ts`, the single place those samples exist - inside a
 * terminal-shaped surface on the panel token. A visitor arriving at a sign-in
 * screen sees what a search returns before they have typed a password, and the
 * claim is demonstrated rather than asserted.
 *
 * It is server-rendered and motionless on purpose: there is nothing to reveal
 * in text that is already fully visible, and a typewriter on a sign-in screen
 * just delays the form. The only motion is the wash drifting, the dashed ring
 * turning, and the monogram's halo breathing - all gated, all transform/opacity.
 */
const SAMPLE = DEMO_SCANS[0];

export function AuthShell({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(false);
  useLayoutEffect(() => {
    setMounted(true);
  }, []);
  const reduce = useReducedMotion();

  return (
    <main className="relative grid min-h-dvh grid-cols-1 bg-background text-foreground lg:grid-cols-2">
      <div className="absolute right-4 top-4 z-20">
        <ThemeToggle className="border border-btn-border/60 bg-background/80 text-foreground hover:bg-accent/10" />
      </div>
      <div className="relative hidden items-center justify-center overflow-hidden border-r border-neutral-200 px-6 dark:border-neutral-800 lg:flex">
        {/* Wash drift. Slow, decorative-only, gated - it carries no information
            and is hidden from assistive tech. */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_42%,hsl(var(--accent)/0.09),transparent_62%)] motion-safe:animate-ambient-drift" />
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(hsl(var(--foreground)/0.05)_1px,transparent_1px)] [background-size:22px_22px]" />
        <div className="relative flex w-full max-w-md flex-col items-center gap-10">
          {/* One dashed ring, one monogram. The ring is the only thing that
              turns: 60s for a full circuit, so it reads as a slow instrument
              rather than a spinner. */}
          <div
            className="relative flex h-[clamp(11rem,18vw,14rem)] w-[clamp(11rem,18vw,14rem)] items-center justify-center"
            aria-hidden="true"
          >
            {mounted && !reduce && <span className="absolute inset-0 rounded-full border border-dashed border-accent/20 motion-safe:animate-[spin_60s_linear_infinite]" />}
            <span className="absolute inset-10 rounded-full border border-neutral-200 dark:border-neutral-800" />
            <span className="relative flex h-20 w-20 items-center justify-center rounded-2xl bg-accent font-mono text-3xl font-bold text-accent-foreground">
              N
              {mounted && !reduce && <span className="pointer-events-none absolute inset-0 rounded-2xl border border-accent/60 motion-safe:animate-breathe" />}
            </span>
          </div>
          {/* A real sample transcript, not a picture of one. */}
          <div className="w-full rounded-2xl border border-neutral-200 bg-panel p-4 dark:border-neutral-800">
            <p className="font-mono text-xs text-slate-500 dark:text-neutral-500">nusa - zsh</p>
            <p className="mt-3 font-mono text-sm text-slate-900 dark:text-neutral-100">{SAMPLE.command}</p>
            <ul className="mt-2 space-y-1">
              {SAMPLE.output.map((line) => (
                <li key={line} className="font-mono text-xs leading-relaxed text-slate-600 dark:text-neutral-400">
                  {line}
                </li>
              ))}
            </ul>
            <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.2em] text-slate-500 dark:text-neutral-500">
              Demo: sample data
            </p>
          </div>
        </div>
        <div className="absolute inset-x-12 bottom-8">
          <p className="font-mono text-xs uppercase tracking-widest text-accent-text">NUSA project</p>
          <p className="mt-2 max-w-[40ch] text-sm text-slate-600 dark:text-neutral-400">
            Search a domain or IP for open ports, subdomains and known
            vulnerabilities. Every result comes from public records.
          </p>
        </div>
      </div>

      <div className="flex w-full items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-sm py-6">
          <div className="mb-6 flex items-center gap-2.5 lg:hidden">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent font-mono text-lg font-bold text-accent-foreground">N</span>
            <span className="flex flex-col leading-none">
              <span className="font-mono text-sm font-semibold tracking-tight text-slate-900 dark:text-neutral-100">NUSA project</span>
              <span className="mt-1 font-mono text-[10px] uppercase tracking-widest text-accent-text">Security Search</span>
            </span>
          </div>
          {/* The brand name is printed once per screen - on the left panel
              above lg, in the mobile block below it. It used to also sit above
              this form, so a desktop visitor read it twice before typing. */}
          <Reveal>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-neutral-100">{title}</h1>
            <p className="mt-1 text-sm text-slate-600 dark:text-neutral-400">{description}</p>
          </Reveal>
          <Reveal delay={0.08}>{children}</Reveal>
        </div>
      </div>
    </main>
  );
}
