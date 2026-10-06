import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import Reveal from "./Reveal";
import TerminalTyper from "./TerminalTyper";

// Real terminal window: full scan-result text is SSR'd by TerminalTyper
// (SEO/no-JS baseline); after mount it replays as typed command +
// sequential output. Banners render as plain text (see dashboard).
function Terminal() {
  return (
    <div
      role="log"
      aria-label="Sample terminal output of a scan for example.com showing ports, subdomains, WHOIS and a risk score"
      className="overflow-hidden rounded-2xl border border-neutral-200 bg-panel dark:border-neutral-800"
    >
      <div className="flex items-center gap-1.5 border-b border-neutral-200/80 px-4 py-3 dark:border-neutral-800/80">
        <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-neutral-300 motion-safe:animate-blip dark:bg-neutral-700" style={{ animationDelay: "0s" }} />
        <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-neutral-300 motion-safe:animate-blip dark:bg-neutral-700" style={{ animationDelay: "0.3s" }} />
        <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-accent motion-safe:animate-blip" style={{ animationDelay: "0.6s" }} />
        <span className="ml-2 font-mono text-xs text-slate-500 dark:text-neutral-500">osint — zsh</span>
      </div>
      <div className="p-4 font-mono text-[13px] leading-relaxed sm:text-sm">
        <TerminalTyper />
      </div>
    </div>
  );
}

export default function Hero() {
  return (
    <section className="relative mx-auto grid max-w-7xl items-center gap-10 px-4 pb-16 pt-12 sm:px-6 md:pt-20 lg:min-h-[calc(100dvh-4rem)] lg:grid-cols-2 lg:gap-14">
      <div>
        <Reveal>
          <Badge variant="outline" className="border-accent/40 font-mono text-accent">
            <span aria-hidden="true" className="relative mr-2 inline-flex h-1.5 w-1.5">
              <span className="h-full w-full rounded-full bg-accent motion-safe:animate-blip" />
              <span className="absolute inset-0 rounded-full bg-accent motion-safe:animate-[ping_1.8s_ease-out_infinite]" />
            </span>
            PASSIVE OSINT · SHODAN + CRT.SH + WHOIS
          </Badge>
        </Reveal>
        <Reveal delay={0.05}>
          <h1 className="mt-5 max-w-[22ch] text-4xl font-bold leading-none tracking-tighter text-slate-900 dark:text-neutral-50 md:text-5xl lg:text-6xl">
            Know every exposed asset fast
          </h1>
        </Reveal>
        <Reveal delay={0.1}>
          <p className="mt-5 max-w-[65ch] text-base leading-relaxed text-slate-600 dark:text-neutral-400">
            One search box aggregates open ports, subdomains, and WHOIS into a single risk view
            for your domains.
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
            auth-gated · rate-limited · audit-logged
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
          <Terminal />
          <p className="mt-3 text-right font-mono text-xs text-slate-500 dark:text-neutral-500">Sample output</p>
        </div>
      </Reveal>
    </section>
  );
}
