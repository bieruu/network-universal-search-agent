import Link from "next/link";
import { GITHUB_LINK_LABEL, GITHUB_REPO_URL } from "@/lib/site";
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

/**
 * The GitHub mark, drawn as one path at the same 18px optical size as the
 * Sun/Moon glyph beside it.
 *
 * Phosphor's `GithubLogo` was the odd control out: a brand glyph with a
 * heavier, rounder silhouette than anything else in the row, floating with no
 * container while the theme toggle next to it sits in a bordered circle. This
 * is the standard mark (path from the simple-icons set, which mirrors GitHub's
 * own 24-unit artwork), filled in `currentColor` so it takes the same hover
 * colour as the toggle instead of carrying one of its own.
 */
function GithubMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={18}
      height={18}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
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
            NUSA project
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
          {/* The repo link sits with the anchors it belongs to: hidden below
              `md`, the same breakpoint the anchor cluster above collapses at.
              That is not only consistency — the nav at 390px is already
              monogram + wordmark + toggle + CTA, and a fourth fixed-width
              control pushes the row past the viewport.

              It is dressed as the same control the theme toggle is: same
              40px circle, same border, same surface, so the pair reads as one
              row of buttons rather than a button and a loose glyph. */}
          <a
            href={GITHUB_REPO_URL}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={GITHUB_LINK_LABEL}
            className="hidden h-10 w-10 items-center justify-center rounded-full border border-border/80 bg-background/80 text-foreground transition-colors hover:bg-accent/10 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 md:inline-flex"
          >
            <GithubMark />
          </a>
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
