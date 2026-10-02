import { Card, CardTitle } from "@/components/ui/card";
import { Certificate, Database, HardDrives, LockKey, TrendUp } from "@phosphor-icons/react/dist/ssr";
import Reveal from "./Reveal";

const CELLS = [
  {
    icon: HardDrives,
    title: "Open ports & banners",
    body: "Shodan host data mapped to port, product, version. Banners truncated, rendered as plain text.",
    visual: "grid" as const,
  },
  {
    icon: Certificate,
    title: "Subdomains from crt.sh",
    body: "Certificate transparency deduped and capped. Flaky source degrades to partial, never a crash.",
    visual: "none" as const,
  },
  {
    icon: Database,
    title: "WHOIS & domain age",
    body: "Registrar, creation and expiry, name servers. GDPR-redacted emails shown as redacted.",
    visual: "none" as const,
  },
  {
    icon: TrendUp,
    title: "Risk trend per target",
    body: "Transparent heuristic v1 scored on every scan. Last 10 scans charted, snapshots immutable.",
    visual: "metrics" as const,
  },
  {
    icon: LockKey,
    title: "Auth & audit trail",
    body: "Session-gated scans, per-user rate limits, every scan logged with request ID.",
    visual: "tint" as const,
  },
];

function Visual({ kind }: { kind: (typeof CELLS)[number]["visual"] }) {
  if (kind === "grid")
    return (
      <div className="mt-4 grid h-36 grid-cols-3 gap-2 rounded-xl border border-accent/15 bg-slate-900/95 p-2">
        <div className="rounded-md bg-accent/30" />
        <div className="rounded-md bg-slate-700" />
        <div className="rounded-md bg-accent/20" />
        <div className="rounded-md bg-slate-800" />
        <div className="rounded-md bg-accent/35" />
        <div className="rounded-md bg-slate-700" />
      </div>
    );
  if (kind === "metrics")
    return (
      <div className="mt-4 flex h-36 items-end gap-2 rounded-xl border border-accent/15 bg-slate-900/95 p-3">
        {[26, 34, 62, 48, 72, 58, 92].map((value, index) => (
          <div key={value + index} className="flex-1 rounded-t-md bg-gradient-to-t from-accent/70 to-emerald-300/90" style={{ height: `${value}px` }} />
        ))}
      </div>
    );
  if (kind === "tint")
    return (
      <div aria-hidden="true" className="mt-4 rounded-xl border border-accent/25 bg-accent/5 p-3 font-mono text-xs text-slate-700 dark:text-neutral-300">
        <p>POST /api/v1/scan → 401 without session</p>
        <p className="mt-1 text-slate-600 dark:text-neutral-500">GET /history → 200 · paginated</p>
      </div>
    );
  return null;
}

export default function FeatureBento() {
  return (
    <section id="sources" className="mx-auto max-w-7xl px-4 py-16 sm:px-6 md:py-24">
      <Reveal>
        <h2 className="max-w-[20ch] text-3xl font-bold tracking-tighter text-slate-900 dark:text-neutral-50 md:text-4xl">
          Three sources, one triage view
        </h2>
        <p className="mt-3 max-w-[65ch] text-slate-600 dark:text-neutral-400">
          Each source runs with its own timeout. One fails, the scan still lands as partial.
        </p>
      </Reveal>
      <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {CELLS.map((c, i) => (
          <Reveal key={c.title} delay={Math.min(i * 0.05, 0.15)} className={i === 0 ? "sm:col-span-2 lg:col-span-1" : undefined}>
            <Card className="h-full rounded-2xl border-neutral-200 bg-panel p-5 dark:border-neutral-800">
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
