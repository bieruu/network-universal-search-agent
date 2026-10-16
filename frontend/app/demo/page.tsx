import type { Metadata } from "next";
import Link from "next/link";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import DemoReportView from "./demo-report-view";

/**
 * `/demo` — a finished report anyone can open, signed in or not.
 *
 * WHY NO SESSION IS READ: the middleware is CSP-only since the guest-scan
 * reversal (see `middleware.ts`), so nothing redirects this route, and the
 * page itself never asks who is looking — the fixtures are the same for a
 * visitor and for an account. That is the whole point of item (a): a target
 * that can be inspected from the landing page without an account and without
 * a backend. One caveat worth writing down: the root layout calls `headers()`
 * for the CSP nonce, so this route renders per request like the rest of the
 * app — but a render makes no outbound request either, which the contract in
 * `lib/demo-page.test.ts` pins at source level.
 *
 * METADATA: the title and description say "simulated"/"no live scan" in
 * plain words, and `robots.noindex` keeps a fabricated report out of search
 * results where it could read as a real finding.
 */
export const metadata: Metadata = {
  title: "Demo report — simulated output, no live scan",
  description:
    "A static sample of what this product's report looks like, built from fixtures that ship with the site. Nothing on this page is a real scan: no source is contacted and no request is made.",
  robots: { index: false, follow: true },
};

/**
 * Minimal chrome, shaped like the landing nav (same monogram ring, same
 * controls) minus the anchor cluster — those anchors point at sections that
 * only exist on `/`, and a nav full of dead links is worse than a short one.
 */
function DemoHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-neutral-200/80 bg-background/90 backdrop-blur-sm dark:border-neutral-800/80">
      <nav
        aria-label="Primary"
        className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6"
      >
        <Link href="/" className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="relative flex h-8 w-8 items-center justify-center rounded-lg bg-accent font-mono text-sm font-bold text-accent-foreground"
          >
            <span className="pointer-events-none absolute inset-0 rounded-lg border border-accent/50 motion-safe:animate-breathe" />
            N
          </span>
          <span className="font-mono text-sm font-semibold tracking-tight text-foreground dark:text-neutral-100">
            NUSA project — demo
          </span>
        </Link>
        <div className="flex items-center gap-2">
          <ThemeToggle className="border border-border/80 bg-background/80 hover:bg-accent/10" />
          <Link
            href="/dashboard"
            className="rounded-full bg-accent px-5 py-2 text-sm font-semibold text-accent-foreground transition-all duration-300 ease-out hover:-translate-y-0.5 hover:bg-accent-hover hover:shadow-md hover:shadow-accent/25 active:translate-y-0 motion-reduce:transition-colors motion-reduce:hover:translate-y-0"
          >
            Open dashboard
          </Link>
        </div>
      </nav>
    </header>
  );
}

export default function DemoPage() {
  return (
    <div className="relative isolate bg-background text-foreground">
      <DemoHeader />
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        <DemoReportView />
      </main>
    </div>
  );
}
