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
        <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-neutral-300 dark:bg-neutral-700" />
        <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-neutral-300 dark:bg-neutral-700" />
        <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-accent" />
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
    <section className="mx-auto grid max-w-7xl items-center gap-10 px-4 pb-16 pt-12 sm:px-6 md:pt-20 lg:min-h-[calc(100dvh-4rem)] lg:grid-cols-2 lg:gap-14">
      <div>
        <Reveal>
          <Badge variant="outline" className="border-accent/40 font-mono text-accent">
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
              className="rounded-full bg-accent px-6 py-2.5 text-sm font-semibold text-accent-foreground transition-colors hover:bg-accent-hover"
            >
              Open dashboard
            </Link>
            <Link
              href="#how"
              className="rounded-full border border-neutral-300 px-6 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:border-accent/40 hover:bg-accent/10 dark:border-neutral-700 dark:text-neutral-200 dark:hover:border-accent/40 dark:hover:bg-accent/10"
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
        <Terminal />
        <p className="mt-3 text-right font-mono text-xs text-slate-500 dark:text-neutral-500">Sample output</p>
      </Reveal>
    </section>
  );
}
