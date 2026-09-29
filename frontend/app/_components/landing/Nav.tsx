import Link from "next/link";

function Monogram() {
  return (
    <span
      aria-hidden="true"
      className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#00E59B] font-mono text-sm font-bold text-black"
    >
      N
    </span>
  );
}

export default function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b border-neutral-800/80 bg-[#0a0f14]/90 backdrop-blur">
      <nav
        aria-label="Primary"
        className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6"
      >
        <Link href="/" className="flex items-center gap-2.5">
          <Monogram />
          <span className="font-mono text-sm font-semibold tracking-tight text-neutral-100">
            universal-search
          </span>
        </Link>
        <div className="hidden items-center gap-7 text-sm text-neutral-400 md:flex">
          <Link href="#sources" className="transition-colors hover:text-neutral-100">
            Sources
          </Link>
          <Link href="#how" className="transition-colors hover:text-neutral-100">
            How it works
          </Link>
          <Link href="#security" className="transition-colors hover:text-neutral-100">
            Security
          </Link>
        </div>
        <Link
          href="/dashboard"
          className="rounded-full bg-[#00E59B] px-5 py-2 text-sm font-semibold text-black transition-opacity hover:opacity-90"
        >
          Open dashboard
        </Link>
      </nav>
    </header>
  );
}
