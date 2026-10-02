import Link from "next/link";
import Reveal from "./Reveal";

export default function CtaFooter() {
  return (
    <>
      <section className="border-t border-neutral-200 dark:border-neutral-800/80">
        <div className="mx-auto max-w-7xl px-4 py-16 text-center sm:px-6 md:py-24">
          <Reveal>
            <h2 className="mx-auto max-w-[16ch] text-3xl font-bold tracking-tighter text-slate-900 dark:text-neutral-50 md:text-4xl">
              Scan your first target today
            </h2>
            <p className="mx-auto mt-3 max-w-[65ch] text-slate-600 dark:text-neutral-400">
              Sign in, type a domain, get ports, subdomains, and WHOIS in one view.
            </p>
            <Link
              href="/dashboard"
              className="mt-8 inline-block rounded-full bg-accent px-7 py-2.5 text-sm font-semibold text-accent-foreground transition-colors hover:bg-accent-hover"
            >
              Open dashboard
            </Link>
          </Reveal>
        </div>
      </section>
      <footer className="border-t border-neutral-200 dark:border-neutral-800/80">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-3 px-4 py-6 font-mono text-xs text-slate-500 dark:text-neutral-500 sm:flex-row sm:px-6">
          <p>universal-search · passive OSINT only</p>
          <div className="flex gap-5">
            <Link href="/dashboard" className="transition-colors hover:text-accent">
              Dashboard
            </Link>
            <Link href="/sign-in" className="transition-colors hover:text-accent">
              Sign in
            </Link>
          </div>
        </div>
      </footer>
    </>
  );
}
