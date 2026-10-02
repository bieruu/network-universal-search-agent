import Image from "next/image";
import { Card, CardTitle } from "@/components/ui/card";
import { Certificate, Database, HardDrives, LockKey, TrendUp } from "@phosphor-icons/react/dist/ssr";
import Reveal from "./Reveal";

// 5 cells for 5 contents: shodan, crt.sh, whois, trends, auth/audit.
// 3 cells carry a visual (2 photos + 1 tinted terminal strip).
const CELLS = [
  {
    icon: HardDrives,
    title: "Open ports & banners",
    body: "Shodan host data mapped to port, product, version. Banners truncated, rendered as plain text.",
    visual: "photo-server" as const,
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
    visual: "photo-certs" as const,
  },
  {
    icon: LockKey,
    title: "Auth & audit trail",
    body: "Session-gated scans, per-user rate limits, every scan logged with request ID.",
    visual: "tint" as const,
  },
];

function Visual({ kind }: { kind: (typeof CELLS)[number]["visual"] }) {
  if (kind === "photo-server")
    return (
      <div className="relative mt-4 h-36 overflow-hidden rounded-xl">
        <Image
          src="https://picsum.photos/seed/server-rack/800/600"
          alt="Server rack in a dark data center"
          fill
          sizes="(max-width: 768px) 100vw, 400px"
          className="object-cover"
          loading="lazy"
        />
        {/* TODO: ganti foto asli */}
      </div>
    );
  if (kind === "photo-certs")
    return (
      <div className="relative mt-4 h-36 overflow-hidden rounded-xl">
        <Image
          src="https://picsum.photos/seed/tls-certs/800/600"
          alt="Close-up of network hardware status lights"
          fill
          sizes="(max-width: 768px) 100vw, 400px"
          className="object-cover"
          loading="lazy"
        />
        {/* TODO: ganti foto asli */}
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
