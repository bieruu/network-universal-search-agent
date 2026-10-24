import Link from "next/link";
import AmbientBackdrop from "./AmbientBackdrop";
import Reveal from "./Reveal";

export default function CtaFooter() {
  return (
    <>
      <section className="relative overflow-hidden border-t border-neutral-200 dark:border-neutral-800/80">
        <AmbientBackdrop variant="landing" />
        <div className="relative mx-auto max-w-7xl px-4 py-16 text-center sm:px-6 md:py-24">
          <Reveal>
            <h2 className="mx-auto max-w-[16ch] text-3xl font-bold tracking-tighter text-slate-900 dark:text-neutral-50 md:text-4xl">
              Scan your first target today
            </h2>
            <p className="mx-auto mt-3 max-w-[65ch] text-slate-600 dark:text-neutral-400">
              Sign in, enter a domain, and read the full report.
            </p>
            <Link
              href="/dashboard"
              className="relative mt-8 inline-flex h-9 items-center rounded-full bg-accent px-4 text-sm font-semibold text-accent-foreground ring-1 ring-accent/30 transition-colors duration-200 after:absolute after:-inset-1.5 after:content-[''] hover:bg-accent-hover sm:mt-10 sm:hover:-translate-y-0.5 sm:hover:shadow-lg sm:hover:shadow-accent/25 sm:active:translate-y-0 sm:motion-reduce:hover:translate-y-0"
            >
              Open dashboard
            </Link>
          </Reveal>
        </div>
      </section>
      <footer className="border-t border-neutral-200 dark:border-neutral-800/80">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-3 px-4 py-6 font-mono text-xs text-slate-500 dark:text-neutral-500 sm:flex-row sm:px-6">
          <p>© 2026 NUSA project</p>
          <div className="flex gap-5">
            <Link href="/dashboard" className="transition-colors hover:text-accent-text">
              Dashboard
            </Link>
            <Link href="/sign-in" className="transition-colors hover:text-accent-text">
              Sign in
            </Link>
            <Link href="/demo" className="transition-colors hover:text-accent-text">
              Demo report
            </Link>
          </div>
        </div>
      </footer>
    </>
  );
}
