import Link from "next/link";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import ScrollProgress from "./ScrollProgress";

function Monogram() {
  return (
    <span
      aria-hidden="true"
      className="relative flex h-8 w-8 items-center justify-center rounded-lg bg-accent font-mono text-sm font-bold text-accent-foreground"
    >
      <span className="pointer-events-none absolute inset-0 rounded-lg border border-accent/50 motion-safe:animate-breathe" />
      N
    </span>
  );
}

export default function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b border-neutral-200/80 bg-background/90 backdrop-blur-sm dark:border-neutral-800/80">
      <ScrollProgress />
      <nav
        aria-label="Primary"
        className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6"
      >
        <Link href="/" className="flex items-center gap-2.5">
          <Monogram />
          <span className="font-mono text-sm font-semibold tracking-tight text-foreground dark:text-neutral-100">
            universal-search
          </span>
        </Link>
        <div className="hidden items-center gap-7 text-sm text-slate-600 dark:text-neutral-400 md:flex">
          <Link href="#sources" className="transition-colors hover:text-accent">
            Sources
          </Link>
          <Link href="#how" className="transition-colors hover:text-accent">
            How it works
          </Link>
          <Link href="#security" className="transition-colors hover:text-accent">
            Security
          </Link>
        </div>
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
