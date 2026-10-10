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
              Sign in, enter a domain, and see its open ports, subdomain names, and registration details together.
            </p>
            <Link
              href="/dashboard"
              className="mt-8 inline-block rounded-full bg-accent px-7 py-2.5 text-sm font-semibold text-accent-foreground transition-all duration-200 hover:-translate-y-0.5 hover:bg-accent-hover hover:shadow-lg hover:shadow-accent/25 active:translate-y-0 motion-reduce:transition-colors motion-reduce:hover:translate-y-0"
            >
              Open dashboard
            </Link>
          </Reveal>
        </div>
      </section>
      <footer className="border-t border-neutral-200 dark:border-neutral-800/80">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-3 px-4 py-6 font-mono text-xs text-slate-500 dark:text-neutral-500 sm:flex-row sm:px-6">
          <p>Public sources only · your targets are never contacted</p>
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
