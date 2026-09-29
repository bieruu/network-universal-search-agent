import Link from "next/link";
import Reveal from "./Reveal";

export default function CtaFooter() {
  return (
    <>
      <section className="border-t border-neutral-800/80">
        <div className="mx-auto max-w-7xl px-4 py-16 text-center sm:px-6 md:py-24">
          <Reveal>
            <h2 className="mx-auto max-w-[16ch] text-3xl font-bold tracking-tighter text-neutral-50 md:text-4xl">
              Scan your first target today
            </h2>
            <p className="mx-auto mt-3 max-w-[65ch] text-neutral-400">
              Sign in, type a domain, get ports, subdomains, and WHOIS in one view.
            </p>
            <Link
              href="/dashboard"
              className="mt-8 inline-block rounded-full bg-[#00E59B] px-7 py-2.5 text-sm font-semibold text-black transition-opacity hover:opacity-90"
            >
              Open dashboard
            </Link>
          </Reveal>
        </div>
      </section>
      <footer className="border-t border-neutral-800/80">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-3 px-4 py-6 font-mono text-xs text-neutral-500 sm:flex-row sm:px-6">
          <p>universal-search · passive OSINT only</p>
          <div className="flex gap-5">
            <Link href="/dashboard" className="transition-colors hover:text-neutral-200">
              Dashboard
            </Link>
            <Link href="/sign-in" className="transition-colors hover:text-neutral-200">
              Sign in
            </Link>
          </div>
        </div>
      </footer>
    </>
  );
}
