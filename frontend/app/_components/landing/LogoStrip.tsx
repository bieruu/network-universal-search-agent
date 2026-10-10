import Reveal from "./Reveal";

// Provenance, not a stack wall. The previous version listed the frameworks the
// product is built on, which tells a visitor nothing they are buying. What a
// buyer does want to know is whose public records the answer comes from.
const SOURCES = [
  { mark: "shodan", detail: "internet-wide service and host data" },
  { mark: "crt.sh", detail: "the public certificate log" },
  { mark: "whois", detail: "public domain registration records" },
  { mark: "NVD", detail: "the NIST vulnerability database" },
] as const;

export default function LogoStrip() {
  return (
    <section
      aria-label="Public records these results are drawn from"
      className="border-y border-neutral-200 dark:border-neutral-800/80"
    >
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-center gap-x-10 gap-y-4 px-4 py-6 sm:px-6">
        {SOURCES.map((s, i) => (
          <Reveal key={s.mark}>
            <span className="flex items-baseline gap-2 motion-safe:animate-bob" style={{ animationDelay: `${i * 0.5}s` }}>
              <span className="font-mono text-sm font-semibold text-accent">{s.mark}</span>
              <span className="text-xs text-slate-500 dark:text-neutral-500">{s.detail}</span>
            </span>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
