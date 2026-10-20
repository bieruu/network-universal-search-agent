"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { phaseDelay } from "@/lib/motion-phases";
import Reveal from "./Reveal";
import HeroGlobe from "./HeroGlobe";
import PlaygroundTerminal from "./PlaygroundTerminal";
import type { TerminalSample } from "./terminal-lines";

// Real terminal window: full scan-result text is SSR'd by the terminal
// (SEO/no-JS baseline); after mount it replays as typed command +
// sequential output. Banners render as plain text (see dashboard).
function Terminal({
  sample,
  signedIn,
  label,
}: {
  sample?: TerminalSample | null;
  signedIn: boolean;
  label: string;
}) {
  return (
    <div
      role="log"
      aria-label={label}
      className="overflow-hidden rounded-2xl border border-neutral-200 bg-panel dark:border-neutral-800"
    >
      <div className="flex items-center gap-1.5 border-b border-neutral-200/80 px-4 py-3 dark:border-neutral-800/80">
        <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-neutral-300 motion-safe:animate-blip dark:bg-neutral-700" style={{ animationDelay: phaseDelay(0, "blip") }} />
        <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-neutral-300 motion-safe:animate-blip dark:bg-neutral-700" style={{ animationDelay: phaseDelay(1, "blip") }} />
        <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-accent motion-safe:animate-blip" style={{ animationDelay: phaseDelay(2, "blip") }} />
        <span className="ml-2 font-mono text-xs text-slate-500 dark:text-neutral-500">osint — zsh</span>
      </div>
      <div className="p-4">
        <PlaygroundTerminal signedIn={signedIn} sample={sample} />
      </div>
    </div>
  );
}

export default function Hero({
  sample,
  signedIn = false,
}: {
  sample?: TerminalSample | null;
  signedIn?: boolean;
}) {
  // The flank chips' single selection (operator's interactive-flanks
  // revision, 2026-10-16). Lives HERE rather than in HeroGlobe so the globe
  // component stays a pure picture engine: `selected` flows down as a prop,
  // `setSelected` doubles as the chips' toggle handler (null = resting state),
  // and HeroGlobe uses the same value to emphasise the matching marker label
  // and forwards both into HeroFlanks. One selection, three surfaces.
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <section className="relative mx-auto grid max-w-7xl items-center gap-10 px-4 pb-[25rem] pt-12 sm:px-6 sm:pb-[30rem] md:pt-16 lg:min-h-[calc(100dvh-4rem)] lg:grid-cols-2 lg:gap-x-14 lg:gap-y-8 lg:pb-10">
      <div>
        <Reveal>
          <Badge variant="outline" className="border-accent/40 font-mono text-accent">
            <span aria-hidden="true" className="relative mr-2 inline-flex h-1.5 w-1.5">
              <span className="h-full w-full rounded-full bg-accent motion-safe:animate-blip" />
              <span className="absolute inset-0 rounded-full bg-accent motion-safe:animate-[ping_1.8s_ease-out_infinite]" />
            </span>
            PUBLIC RECORDS ONLY
          </Badge>
        </Reveal>
        <Reveal delay={0.05}>
          <h1 className="mt-5 max-w-[22ch] text-4xl font-bold leading-none tracking-tighter text-slate-900 dark:text-neutral-50 md:text-5xl lg:text-6xl">
            See what a domain exposes to the internet
          </h1>
        </Reveal>
        <Reveal delay={0.1}>
          <p className="mt-5 max-w-[65ch] text-base leading-relaxed text-slate-600 dark:text-neutral-400">
            Enter one domain and read its open ports, subdomains, registration
            details and risk score — only DNS lookups reach
            the target&apos;s nameservers.
          </p>
        </Reveal>
        <Reveal delay={0.15}>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              href="/dashboard"
              className="relative rounded-full bg-accent px-6 py-2.5 text-sm font-semibold text-accent-foreground transition-all duration-300 ease-out hover:-translate-y-0.5 hover:bg-accent-hover hover:shadow-lg hover:shadow-accent/25 active:translate-y-0 motion-reduce:transition-colors motion-reduce:hover:translate-y-0"
            >
              <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-full border border-accent/60 motion-safe:animate-breathe" />
              Open dashboard
            </Link>
            <Link
              href="#how"
              className="rounded-full border border-neutral-300 px-6 py-2.5 text-sm font-medium text-slate-700 transition-all duration-200 hover:-translate-y-0.5 hover:border-accent/40 hover:bg-accent/10 active:translate-y-0 motion-reduce:transition-colors motion-reduce:hover:translate-y-0 dark:border-neutral-700 dark:text-neutral-200 dark:hover:border-accent/40 dark:hover:bg-accent/10"
            >
              How it works
            </Link>
          </div>
        </Reveal>
        <Reveal delay={0.2}>
          <p className="mt-6 font-mono text-xs text-slate-500 dark:text-neutral-500">
            Private to your account · every search is recorded for you
          </p>
        </Reveal>
      </div>
      <Reveal delay={0.1}>
        <div className="relative">
          {/* Rotating dashed dial + radar ping at the terminal corner.
              A rotated 64px square paints a ~90.5px bbox (+13.25px per side),
              so the offset must stay ≤2.75px under px-4 (16px) page padding to
              keep the page overflow-free at 390 — hence right-0 below sm and
              the 8px bleed only at sm+ where px-6 (24px) absorbs it. */}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -top-4 right-0 z-10 flex h-16 w-16 items-center justify-center rounded-full border border-dashed border-accent/50 motion-safe:animate-[spin_10s_linear_infinite] sm:-right-2"
          >
            <span className="h-2 w-2 rounded-full bg-accent motion-safe:animate-ping" />
          </span>
          <Terminal
            sample={sample}
            signedIn={signedIn}
            label={
              sample
                ? "Output of your most recent search, domain name masked"
                : "Example terminal output for example.com: open ports, subdomains, domain details, risk score"
            }
          />
          {/* The window answers four lines; `/demo` is the same fixtures laid
              out as a full report. Sits under the terminal, where the demo
              caption already told the visitor the output is simulated — the
              link inherits that context instead of asking for trust twice. */}
          <p className="mt-2 text-right font-mono text-xs text-slate-500 dark:text-neutral-500">
            <Link
              href="/demo"
              className="transition-colors hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 lg:inline-block lg:rounded-full lg:border lg:border-neutral-200/80 lg:bg-background/85 lg:px-3 lg:py-1 dark:lg:border-neutral-800/80"
            >
              Open the full demo report →
            </Link>
          </p>
        </div>
      </Reveal>
      {/* Globe stage (2026-10-15 architecture; operator's z-order override):
          the band carries NO negative z-index — it paints in normal flow, on
          top by paint order, and stays out of the copy's way through geometry
          alone. On lg+ the band is its own grid row (`lg:col-span-2`) below
          both columns; below lg it occupies the dedicated stage the section's
          bottom padding carves out (pb-[25rem] under w-[min(24rem,88vw)],
          sm:pb-[30rem] under sm:w-[26rem] — measured gap below the demo link:
          ≈25px at 390 (measured 24.8px), at least 32px at 768), so it never
          covers the H1, the paragraph or the CTAs. WHY it must not go back to
          `-z-10`:
          a negative z-index paints the canvas BELOW `section` and `main` (both
          pointer-events:auto, both border boxes covering the sphere), so
          hit-testing never reaches it and drag-to-spin dies silently — proven
          2026-10-15 by elementFromPoint (always SECTION/terminal, never the
          canvas) plus a 0-pixel drag diff against baseline. The corner dial is
          deliberately `-right-2` (8px slack at 390) inside a wrapper with no
          overflow clip, so the ring is never sliced. The band still fades in
          from its top edge (mask at the 30 percent mark). The band's lg+
          flanks now also carry two INTERACTIVE panels (`HeroFlanks.tsx`,
          operator 2026-10-16): example-target chips on the left, a fixture
          readout of the pick on the right — outside the sphere's square
          wrapper, lg+ only, so they never touch the copy or the drag
          surface. The selection state lives above and arrives via props. */}
      <HeroGlobe selected={selected} onSelect={setSelected} />
    </section>
  );
}
