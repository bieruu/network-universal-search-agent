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
    title: "Scan a target",
    body: "Enter a domain or public IP. Private network addresses are refused.",
  },
  {
    n: "03",
    title: "Read the result",
    body: "Cards, tables and charts; every search stays in your history to reopen and compare.",
  },
];

/**
 * The right-hand column used to be a div-based fake screenshot: three pills of
 * empty rounded rectangles that pulsed, standing in for a list nobody had
 * written. It looked like content and carried none.
 *
 * It now shows what the result is actually assembled from — one row per data
 * source, what that source contributes, and what the rest of the result says
 * when it cannot be reached. The sentences are the same ones the source chips
 * in the logo strip answer with (`source-copy.ts`, one declaration, two
 * surfaces), because there is no second version of the truth about what a
 * source gives.
 *
 * That second half of every row is the product's core claim: a source that
 * fails says so, so an empty card is never read as good news.
 */
export default function HowItWorks() {
  return (
    <section id="how" className="border-y border-neutral-200 bg-slate-50 dark:border-neutral-800/80 dark:bg-[#0c1117]">
      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-16 sm:px-6 md:py-24 lg:grid-cols-2">
        <div>
          <Reveal>
            <p className="font-mono text-xs tracking-widest text-accent">HOW IT WORKS</p>
            <h2 className="mt-3 text-3xl font-bold tracking-tighter text-slate-900 dark:text-neutral-50 md:text-4xl">
              Three steps to a full picture
            </h2>
          </Reveal>
          <ol className="mt-8 space-y-0">
            {STEPS.map((s, i) => (
              <li key={s.n} className="flex gap-5 border-t border-neutral-200 py-5 last:border-b dark:border-neutral-800">
                <Reveal delay={i * 0.05} className="flex gap-5">
                  <span aria-hidden="true" className="font-mono text-sm text-accent">
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
        <Reveal delay={0.1} className="relative min-h-72 overflow-hidden rounded-2xl border border-neutral-200 bg-panel p-5 dark:border-neutral-800">
          {/* Opacity-only wash behind the panel: it reads as a surface being
              read, never as content that moves (nothing in the rows animates
              its position at all). */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-accent/5 motion-safe:animate-ambient-pulse"
          />
          <div className="relative flex h-full flex-col">
            <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.2em] text-slate-500 dark:text-neutral-400">
              <span>one search · four sources</span>
              <span className="flex items-center gap-1.5">
                <span aria-hidden="true" className="relative inline-flex h-1.5 w-1.5">
                  <span className="h-full w-full rounded-full bg-accent motion-safe:animate-blip" />
                  <span className="absolute inset-0 rounded-full bg-accent motion-safe:animate-[ping_1.8s_ease-out_infinite]" />
                </span>
                each source answers on its own
              </span>
            </div>
            <ul className="mt-5 divide-y divide-neutral-200 dark:divide-neutral-800">
              {SOURCES.map((s) => (
                <li key={s.mark} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-mono text-xs text-accent">{s.mark}</span>
                    <span className="text-xs text-slate-500 dark:text-neutral-500">{s.detail}</span>
                  </div>
                  <p className="mt-1 max-w-[60ch] text-sm leading-relaxed text-slate-700 dark:text-neutral-300">
                    {s.gives}
                  </p>
                  <p className="mt-1 max-w-[60ch] text-xs leading-relaxed text-slate-500 dark:text-neutral-500">
                    {s.whenSlow}
                  </p>
                </li>
              ))}
            </ul>
            <div className="mt-5 space-y-3 rounded-xl border border-neutral-200 bg-white/70 p-3 shadow-xs dark:border-neutral-800 dark:bg-neutral-900/80">
              <div className="flex items-center justify-between text-xs text-slate-600 dark:text-neutral-400">
                <span>Risk score</span>
                <span className="font-mono text-accent">0 to 100</span>
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
