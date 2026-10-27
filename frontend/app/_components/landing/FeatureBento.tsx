import { Card, CardTitle } from "@/components/ui/card";
import { Certificate } from "@phosphor-icons/react/dist/ssr/Certificate";
import { Database } from "@phosphor-icons/react/dist/ssr/Database";
import { HardDrives } from "@phosphor-icons/react/dist/ssr/HardDrives";
import { LockKey } from "@phosphor-icons/react/dist/ssr/LockKey";
import { TrendUp } from "@phosphor-icons/react/dist/ssr/TrendUp";
import { BentoGridVisual, BentoMetricsVisual } from "./BentoVisuals";
import Reveal from "./Reveal";

const CELLS = [
  {
    icon: HardDrives,
    title: "See what is open, and what is running",
    body: "Open ports with the software and version answering on each.",
    visual: "grid" as const,
  },
  {
    icon: Certificate,
    title: "Names nobody put on a page",
    body: "Machine names under your domain, from the public certificate log.",
    visual: "none" as const,
  },
  {
    icon: Database,
    title: "Who holds the domain, and since when",
    body: "The public WHOIS record: holder, created and expiry dates, and nameservers.",
    visual: "none" as const,
  },
  {
    icon: TrendUp,
    title: "Know where to look first",
    body: "A 0 to 100 score per search, with your recent scans charted.",
    visual: "metrics" as const,
  },
  {
    icon: LockKey,
    title: "Only you can see your searches",
    body: "Sign-in required, history visible only to your account, every search recorded with its time.",
    visual: "tint" as const,
  },
];

function Visual({ kind }: { kind: (typeof CELLS)[number]["visual"] }) {
  if (kind === "grid") return <BentoGridVisual />;
  if (kind === "metrics") return <BentoMetricsVisual />;
  if (kind === "tint")
    return (
      <div aria-hidden="true" className="mt-4 rounded-xl border border-accent/25 bg-accent/5 p-3 font-mono text-xs text-slate-700 dark:text-neutral-300">
        <p>Your search history</p>
        <p className="mt-1 text-fg-muted">
          Every search you run, newest first
        </p>
      </div>
    );
  return null;
}

export default function FeatureBento() {
  return (
    <section id="sources" className="mx-auto max-w-7xl px-4 py-16 sm:px-6 md:py-24">
      <Reveal>
        <h2 className="max-w-[20ch] text-3xl font-bold tracking-tighter text-slate-900 dark:text-neutral-50 md:text-4xl">
          What one search shows you
        </h2>
        <p className="mt-3 max-w-[65ch] text-slate-600 dark:text-neutral-400">
          A slow source never blanks the report. Every failed check is named, so a gap is never good news.
        </p>
      </Reveal>
      <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {CELLS.map((c, i) => (
          <Reveal key={c.title} delay={Math.min(i * 0.05, 0.15)} className={i === 0 ? "sm:col-span-2 lg:col-span-1" : undefined}>
            <Card className="h-full rounded-2xl border-neutral-200 bg-panel p-5 transition-all duration-200 hover:-translate-y-1 hover:border-accent/40 hover:shadow-lg hover:shadow-accent/10 motion-reduce:transition-none motion-reduce:hover:translate-y-0 dark:border-neutral-800">
              <c.icon size={22} weight="regular" className="text-accent" aria-hidden="true" />
              <CardTitle className="mt-3 text-base text-slate-900 dark:text-neutral-100">{c.title}</CardTitle>
              <p className="mt-2 text-sm leading-relaxed text-slate-600 dark:text-neutral-400">{c.body}</p>
              <Visual kind={c.visual} />
            </Card>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
