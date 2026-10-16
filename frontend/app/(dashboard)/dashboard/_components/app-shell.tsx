"use client";

import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { GithubLogo, List, MagnifyingGlass, SignOut } from "@phosphor-icons/react/dist/ssr";
import { Button, buttonClasses } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { GITHUB_LINK_LABEL, GITHUB_REPO_URL } from "@/lib/site";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { App1Sidebar, SidebarInset, SidebarProvider } from "@/components/ui/app-1-utils/app-1-sidebar";
import { authClient } from "@/lib/auth-client";
import { isGuestSession } from "@/lib/guest";
import { cn } from "@/lib/utils";
import AmbientLayer from "./ambient-layer";
// Pure shell: sidebar + sticky header + content slot. All scan sections
// (stats, charts, tables, history) live in page.tsx so one file owns the order.
//
// The header used to carry a notifications bell: an icon button labelled
// "Notifications" that had no handler, no menu and nothing to notify about. A
// control a screen reader announces but cannot operate is worse than no control,
// so it is gone rather than faked.
//
// The ambient layer behind the shell is the 2026-10-12 reversal of the old
// "dashboard data 100% static" lock — see `ambient-layer.tsx` for what the
// reversal kept. In short: the plane moves, nothing on it does.
export default function AppShell({
  target,
  children,
}: {
  target: string | null;
  children: ReactNode;
}) {
  const router = useRouter();
  const sessionState = authClient.useSession();
  const session = sessionState.data;
  // Logout only means something with a session to end. A guest clicking it
  // would call signOut() against no session and land on a sign-in page for an
  // account they do not have — so the control is hidden instead of faked.
  const guest = isGuestSession(sessionState);

  async function handleLogout() {
    await authClient.signOut();
    // Landing, not /sign-in (reversal 2026-10-14): leaving the app should not
    // drop you on the one page whose only business is starting an account.
    router.push("/");
    router.refresh();
  }

  return (
    <SidebarProvider>
      {/* This div must CARRY the flex contract, not sit inside it.
          `SidebarProvider` renders `flex min-h-dvh` and its whole job is to lay
          the sidebar out BESIDE the content. A plain wrapper dropped between
          that container and the two things it arranges turns both of them back
          into block boxes in normal flow: the sidebar falls to the top-left,
          the content stacks underneath it in the same 240px column, and because
          the sidebar is `sticky top-0 h-dvh` it then stays pinned across the
          content while the page scrolls.

          Measured in Chrome against this project's production CSS before the
          fix was chosen (viewport 1280): sidebar.x = 0, main.x = 0,
          intrusion 240px, and after scrolling the element on top at the
          crossing was the ASIDE. On a 390px viewport the content column
          collapsed to 91px wide.

          So the wrapper IS the flex row (`flex w-full`): the ambient layer is
          `absolute` and therefore out of flow, which leaves the sidebar and the
          inset as the two flex items again. `relative isolate` keeps the layer's
          `-z-10` inside this stacking context so it sits above the page
          background and below the content — the same pattern the landing page
          already uses. */}
      <div className="relative isolate flex w-full">
        <AmbientLayer />
        <App1Sidebar active="/dashboard" />
        <SidebarInset>
          <header className="sticky top-0 z-10 flex h-16 items-center gap-2 border-b border-btn-border bg-background/90 px-4 backdrop-blur-sm">
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="shrink-0 md:hidden" aria-label="Open menu">
                  <List size={22} weight="regular" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left">
                <SheetHeader>
                  <SheetTitle>NUSA project</SheetTitle>
                </SheetHeader>
                <App1Sidebar active="/dashboard" className="flex w-full border-r-0 p-0 max-md:flex" />
              </SheetContent>
            </Sheet>
            <h1 className="min-w-0 flex-1 truncate text-base font-semibold">
              {target ? `Scan ${target}` : "Welcome back"}
            </h1>
            {/* One session indicator, and one element rather than two: the
                header used to print the account name and then the account's
                initial again in an avatar beside it — the same fact twice. What
                is left says the one thing an analyst needs from chrome at a
                glance: this session is live, and here is whose it is. */}
            {session?.user && (
              <p className="hidden max-w-[200px] items-center gap-2 text-sm text-slate-600 dark:text-neutral-400 sm:flex">
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent motion-safe:animate-blip"
                />
                <span className="truncate">{session.user.name ?? session.user.email}</span>
              </p>
            )}
            {/* The repo link, in the ghost icon-button family the header's
                other controls already use — the same classes, on an <a>,
                so it reads as one of the header's controls rather than a
                stray link. Taken from `buttonClasses` rather than retyped so
                the two cannot drift apart.
                `shrink-0` matters: the <h1> beside it is `flex-1 min-w-0
                truncate`, so on a 390px viewport the title is what gives up
                the width, never the control being pushed off-screen.
                The ring is added rather than inherited: `buttonClasses` carries
                `focus:outline-hidden`, which hides the UA outline without
                replacing it, so an anchor in that family would be focusable
                with nothing to show for it. */}
            <a
              href={GITHUB_REPO_URL}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={GITHUB_LINK_LABEL}
              className={cn(buttonClasses("ghost", "icon"), "shrink-0 focus-visible:ring-2 focus-visible:ring-accent/40")}
            >
              <GithubLogo size={20} weight="regular" aria-hidden="true" />
            </a>
            <Button variant="ghost" size="icon" className="shrink-0" aria-label="Search target" onClick={() => document.getElementById("target-search")?.focus()}>
              <MagnifyingGlass size={20} weight="regular" />
            </Button>
            <ThemeToggle />
            {!guest && (
              <Button variant="ghost" size="icon" className="shrink-0" aria-label="Log out" title="Log out" onClick={handleLogout}>
                <SignOut size={20} weight="regular" />
              </Button>
            )}
          </header>

          <main className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 md:p-6">{children}</main>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
