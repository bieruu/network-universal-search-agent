import Reveal from "./Reveal";

const STEPS = [
  {
    n: "01",
    title: "Sign in",
    body: "Session cookie gates the dashboard and every scan endpoint. No session, no data.",
  },
  {
    n: "02",
    title: "Scan a target",
    body: "Type a domain or IPv4. Private ranges and localhost are blocked before anything runs.",
  },
  {
    n: "03",
    title: "Triage the result",
    body: "Cards, tables, and charts fill per source. Snapshots persist in history, immutable.",
  },
];

export default function HowItWorks() {
  return (
    <section id="how" className="border-y border-neutral-200 bg-slate-50 dark:border-neutral-800/80 dark:bg-[#0c1117]">
      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-16 sm:px-6 md:py-24 lg:grid-cols-2">
        <div>
          <Reveal>
            <p className="font-mono text-xs tracking-widest text-accent">HOW IT WORKS</p>
            <h2 className="mt-3 text-3xl font-bold tracking-tighter text-slate-900 dark:text-neutral-50 md:text-4xl">
              From target to triage fast
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
        <Reveal delay={0.1} className="relative min-h-72 overflow-hidden rounded-2xl border border-neutral-200 bg-gradient-to-br from-accent/10 via-slate-100 to-slate-200 p-5 dark:border-neutral-800 dark:from-accent/10 dark:via-neutral-900 dark:to-[#101923]">
          <div className="flex h-full flex-col justify-between">
            <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.2em] text-slate-500 dark:text-neutral-400">
              <span>ops</span>
              <span>live</span>
            </div>
            <div className="mt-6 grid gap-2">
              <div className="h-4 w-2/3 rounded-full bg-accent/40" />
              <div className="h-4 w-5/6 rounded-full bg-slate-300 dark:bg-neutral-700" />
              <div className="h-4 w-2/5 rounded-full bg-accent/25" />
            </div>
            <div className="mt-8 space-y-3 rounded-xl border border-neutral-200 bg-white/70 p-3 shadow-xs dark:border-neutral-800 dark:bg-neutral-900/80">
              <div className="flex items-center justify-between text-xs text-slate-600 dark:text-neutral-400">
                <span>risk signal</span>
                <span className="font-mono text-accent">heuristic</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-neutral-800">
                <div className="h-full w-1/3 rounded-full bg-gradient-to-r from-emerald-400 to-accent" />
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
