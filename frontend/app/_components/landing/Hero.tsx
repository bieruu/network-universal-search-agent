import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import Reveal from "./Reveal";
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
        <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-neutral-300 motion-safe:animate-blip dark:bg-neutral-700" style={{ animationDelay: "0s" }} />
        <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-neutral-300 motion-safe:animate-blip dark:bg-neutral-700" style={{ animationDelay: "0.3s" }} />
        <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-accent motion-safe:animate-blip" style={{ animationDelay: "0.6s" }} />
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
  return (
    <section className="relative mx-auto grid max-w-7xl items-center gap-10 px-4 pb-16 pt-12 sm:px-6 md:pt-20 lg:min-h-[calc(100dvh-4rem)] lg:grid-cols-2 lg:gap-14">
      <div>
        <Reveal>
          <Badge variant="outline" className="border-accent/40 font-mono text-accent">
            <span aria-hidden="true" className="relative mr-2 inline-flex h-1.5 w-1.5">
              <span className="h-full w-full rounded-full bg-accent motion-safe:animate-blip" />
              <span className="absolute inset-0 rounded-full bg-accent motion-safe:animate-[ping_1.8s_ease-out_infinite]" />
            </span>
            PUBLIC RECORDS ONLY · NOTHING ON YOUR TARGET IS TOUCHED
          </Badge>
        </Reveal>
        <Reveal delay={0.05}>
          <h1 className="mt-5 max-w-[22ch] text-4xl font-bold leading-none tracking-tighter text-slate-900 dark:text-neutral-50 md:text-5xl lg:text-6xl">
            See what a domain exposes to the internet
          </h1>
        </Reveal>
        <Reveal delay={0.1}>
          <p className="mt-5 max-w-[65ch] text-base leading-relaxed text-slate-600 dark:text-neutral-400">
            Enter one domain and read its open ports, subdomain names, registration
            details, and a risk score in a single place. Nothing on your target is
            contacted.
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
          {/* Rotating dashed dial + radar ping at the terminal corner. */}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -right-4 -top-4 z-10 flex h-16 w-16 items-center justify-center rounded-full border border-dashed border-accent/50 motion-safe:animate-[spin_10s_linear_infinite]"
          >
            <span className="h-2 w-2 rounded-full bg-accent motion-safe:animate-ping" />
          </span>
          <Terminal
            sample={sample}
            signedIn={signedIn}
            label={
              sample
                ? "Terminal output from your most recent search, with the domain name shortened"
                : "Example terminal output of a search for example.com showing open ports, subdomain names, domain details, and a risk score"
            }
          />
        </div>
      </Reveal>
    </section>
  );
}
