import Image from "next/image";
import Reveal from "./Reveal";

// Numbered rows — different family from the bento cards above.
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
        <Reveal delay={0.1} className="relative min-h-72 overflow-hidden rounded-2xl">
          <Image
            src="https://picsum.photos/seed/soc-analyst/800/1000"
            alt="Security analyst workstation in a dark operations room"
            fill
            sizes="(max-width: 1024px) 100vw, 600px"
            className="object-cover"
            loading="lazy"
          />
          {/* TODO: ganti foto asli */}
        </Reveal>
      </div>
    </section>
  );
}
