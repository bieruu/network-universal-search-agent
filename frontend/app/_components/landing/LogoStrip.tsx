import Reveal from "./Reveal";

// Logo-only wall. Simple Icons CDN for real brands; inline monogram for
// sources without an icon. Fictional marks are monograms, not wordmarks.
const LOGOS = [
  { name: "Next.js", src: "https://cdn.simpleicons.org/nextdotjs/00E59B" },
  { name: "FastAPI", src: "https://cdn.simpleicons.org/fastapi/00E59B" },
  { name: "PostgreSQL", src: "https://cdn.simpleicons.org/postgresql/00E59B" },
] as const;

const MONOGRAMS = ["shodan", "crt.sh", "whois"] as const;

export default function LogoStrip() {
  return (
    <section aria-label="Sources and stack" className="border-y border-neutral-200 dark:border-neutral-800/80">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-center gap-x-10 gap-y-4 px-4 py-6 sm:px-6">
        {LOGOS.map((l) => (
          <Reveal key={l.name}>
            <img src={l.src} alt={l.name} width={28} height={28} loading="lazy" />
          </Reveal>
        ))}
        {MONOGRAMS.map((m) => (
          <Reveal key={m}>
            <span className="font-mono text-sm font-semibold text-accent">{m}</span>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
