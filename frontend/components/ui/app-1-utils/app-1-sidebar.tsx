"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { ClockClockwise, SignIn, SignOut, SquaresFour } from "@phosphor-icons/react/dist/ssr";
import { NAV_ITEMS, SOURCE_MONOGRAMS } from "./app-1-data";
import { authClient } from "@/lib/auth-client";
import { isGuestSession } from "@/lib/guest";
import { cn } from "@/lib/utils";

const NAV_ICONS = { Dashboard: SquaresFour, History: ClockClockwise, "Sign in": SignIn } as const;

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-dvh bg-background text-foreground">{children}</div>;
}

export function SidebarInset({ children }: { children: React.ReactNode }) {
  return <div className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</div>;
}

export function App1Sidebar({ active = "/dashboard", className }: { active?: string; className?: string }) {
  const router = useRouter();
  // Same rule as the header in app-shell.tsx: a guest has nothing to end, so
  // the control is hidden rather than shown and then meaningless.
  const guest = isGuestSession(authClient.useSession());

  async function handleLogout() {
    await authClient.signOut();
    // Landing, not /sign-in — reversal 2026-10-14, see app-shell.tsx.
    router.push("/");
    router.refresh();
  }

  return (
    <aside className={cn("sticky top-0 hidden h-dvh w-60 shrink-0 flex-col gap-6 overflow-y-auto border-r border-btn-border bg-background p-4 md:flex", className)} aria-label="sidebar">
      <Link href="/" className="flex items-center gap-2" aria-label="NUSA project home">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent font-mono text-lg font-bold text-accent-foreground">
          N
        </span>
        <span className="font-mono text-sm font-semibold tracking-tight">NUSA project</span>
      </Link>
      <nav className="flex flex-col gap-1" aria-label="primary">
        {NAV_ITEMS.map((item) => {
          const Icon = NAV_ICONS[item.label as keyof typeof NAV_ICONS] ?? SquaresFour;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active === item.href ? "page" : undefined}
              className={cn(
                "flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors",
                active === item.href
                  ? "bg-accent/10 font-medium text-foreground"
                  : "text-slate-600 hover:bg-accent/10 hover:text-foreground dark:text-neutral-500 dark:hover:bg-accent/10 dark:hover:text-foreground",
              )}
            >
              <Icon size={18} weight="regular" aria-hidden="true" />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div>
        <p className="px-3 font-mono text-[11px] uppercase tracking-widest text-accent">Where the data comes from</p>
        <p className="px-3 pt-1 text-xs text-slate-500 dark:text-neutral-500">
          Every finding is read from a public source. Nothing is ever sent to the target.
        </p>
        <ul className="mt-2 flex flex-col gap-1">
          {SOURCE_MONOGRAMS.map((s) => (
            <li
              key={s.label}
              className="flex items-start gap-2 rounded-lg px-3 py-2 text-sm text-slate-600 dark:text-neutral-500"
              title={`${s.label} — ${s.provenance}`}
            >
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent/10 font-mono text-[10px] font-bold text-accent">
                {s.short}
              </span>
              <span className="min-w-0">
                <span className="block">{s.label}</span>
                <span className="block text-xs opacity-70">{s.provenance}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      {!guest && (
        <div className="mt-auto border-t border-btn-border pt-3">
          <button
            type="button"
            onClick={handleLogout}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-600 transition-colors hover:bg-accent/10 hover:text-foreground dark:text-neutral-500 dark:hover:bg-accent/10 dark:hover:text-foreground"
            aria-label="Log out"
          >
            <SignOut size={18} weight="regular" aria-hidden="true" />
            Log out
          </button>
        </div>
      )}
    </aside>
  );
}
