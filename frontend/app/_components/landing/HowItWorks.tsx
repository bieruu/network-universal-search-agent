import Reveal from "./Reveal";
import RiskMeter from "./RiskMeter";
import { SOURCES } from "./source-copy";

const STEPS = [
  {
    n: "01",
    title: "Sign in",
    body: "Your searches are visible only to your account.",
  },
  {
    n: "02",
    title: "Pick a target",
    body: "Enter a domain or public IP. Private addresses are refused.",
  },
  {
    n: "03",
    title: "Read the result",
    body: "Each search stays in your history to reopen and compare.",
  },
];

/**
 * The right-hand column used to be a div-based fake screenshot: three pills of
 * empty rounded rectangles that pulsed, standing in for a list nobody had
 * written. It looked like content and carried none.
 *
 * It now names the four parts of the report - one row per source, the part it
 * fills and what the visitor gets from it. This panel deliberately does NOT
 * repeat the source names: the logo strip above already prints them
 * (`source-copy.ts`, one declaration, two surfaces). Repeating them here was
 * the duplication the copy audit flagged.
 *
 * The failure story lives once on this page, in `FeatureBento` ("A slow source
 * never blanks the report. Every failed check is named, so a gap is never good
 * news."). Neither this panel nor the strip's answer panel carries it: the
 * strip's failure sentence was removed 2026-10-24 at the operator's request, so
 * do not describe these rows as a partial-failure disclosure.
 */
export default function HowItWorks() {
  return (
    <section id="how" className="border-y border-btn-border bg-band">
      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-16 sm:px-6 md:py-24 lg:grid-cols-2">
        <div>
          <Reveal>
            <p className="font-mono text-xs tracking-widest text-accent-text">HOW IT WORKS</p>
            <h2 className="mt-3 text-3xl font-bold tracking-tighter text-slate-900 dark:text-neutral-50 md:text-4xl">
              Three steps to a full picture
            </h2>
          </Reveal>
          <ol className="mt-8 space-y-0">
            {STEPS.map((s, i) => (
              <li key={s.n} className="flex gap-5 border-t border-btn-border py-5 last:border-b">
                <Reveal delay={i * 0.05} className="flex gap-5">
                  <span aria-hidden="true" className="font-mono text-sm text-accent-text">
                    {s.n}
                  </span>
                  <div>
                    <h3 className="font-semibold text-slate-900 dark:text-neutral-100">{s.title}</h3>
                    <p className="mt-1 text-sm leading-relaxed text-slate-600 dark:text-neutral-400">{s.body}</p>
                  </div>
                </Reveal>
              </li>
            ))}
          </ol>
        </div>
        <Reveal delay={0.1} className="relative min-h-72 overflow-hidden rounded-2xl border border-btn-border bg-panel p-5">
          {/* Opacity-only wash behind the panel: it reads as a surface being
              read, never as content that moves (nothing in the rows animates
              its position at all). */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-accent/5 motion-safe:animate-ambient-pulse"
          />
          <div className="relative flex h-full flex-col">
            <div className="flex items-center justify-between gap-3 text-[10px] uppercase tracking-[0.2em] text-slate-500 dark:text-neutral-400">
              <span>One report, four parts.</span>
              <span>Every part can stand alone.</span>
            </div>
            <ul className="mt-5 divide-y divide-btn-border">
              {SOURCES.map((s) => (
                <li key={s.mark} className="py-3 first:pt-0 last:pb-0">
                  <p className="font-mono text-xs text-accent-text">{s.result}</p>
                  <p className="mt-1 max-w-[60ch] text-sm leading-relaxed text-slate-700 dark:text-neutral-300">
                    {s.outcome}
                  </p>
                </li>
              ))}
            </ul>
            <div className="mt-5 space-y-3 rounded-xl border border-btn-border bg-card/70 p-3 shadow-xs">
              <div className="flex items-center justify-between text-xs text-slate-600 dark:text-neutral-400">
                <span>Risk score</span>
                <span className="font-mono text-accent-text">0 to 100</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-neutral-800">
                <RiskMeter />
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
