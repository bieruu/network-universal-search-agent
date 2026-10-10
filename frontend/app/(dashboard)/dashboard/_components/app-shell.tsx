"use client";

import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { LogOut, Menu, Search } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { App1Sidebar, SidebarInset, SidebarProvider } from "@/components/ui/app-1-utils/app-1-sidebar";
import { authClient } from "@/lib/auth-client";

// Pure shell: sidebar + sticky header + content slot. All scan sections
// (stats, charts, tables, history) live in page.tsx so one file owns the order.
//
// The header used to carry a notifications bell: an icon button labelled
// "Notifications" that had no handler, no menu and nothing to notify about. A
// control a screen reader announces but cannot operate is worse than no control,
// so it is gone rather than faked.
export default function AppShell({
  target,
  children,
}: {
  target: string | null;
  children: ReactNode;
}) {
  const router = useRouter();
  const { data: session } = authClient.useSession();

  async function handleLogout() {
    await authClient.signOut();
    router.push("/sign-in");
    router.refresh();
  }

  return (
    <SidebarProvider>
      <App1Sidebar active="/dashboard" />
      <SidebarInset>
        <header className="sticky top-0 z-10 flex h-16 items-center gap-2 border-b border-btn-border bg-background/90 px-4 backdrop-blur-sm">
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="shrink-0 md:hidden" aria-label="Open menu">
                <Menu size={22} strokeWidth={2} />
              </Button>
            </SheetTrigger>
            <SheetContent>
              <SheetHeader>
                <SheetTitle>Universal Search</SheetTitle>
              </SheetHeader>
              <App1Sidebar active="/dashboard" className="flex w-full border-r-0 p-0 max-md:flex" />
            </SheetContent>
          </Sheet>
          <h1 className="min-w-0 flex-1 truncate text-base font-semibold">
            {target ? `Scan ${target}` : "Welcome back"}
          </h1>
          <Button variant="ghost" size="icon" className="shrink-0" aria-label="Search target" onClick={() => document.getElementById("target-search")?.focus()}>
            <Search size={20} strokeWidth={2} />
          </Button>
          <ThemeToggle />
          <Button variant="ghost" size="icon" className="shrink-0" aria-label="Log out" title="Log out" onClick={handleLogout}>
            <LogOut size={20} strokeWidth={2} />
          </Button>
          <span className="hidden max-w-[180px] truncate text-sm text-slate-600 dark:text-neutral-400 sm:block">
            {session?.user.name ?? session?.user.email}
          </span>
          <Avatar title={session?.user.email ?? "Signed in"}>
            <AvatarFallback>
              {(session?.user.name?.[0] ?? session?.user.email?.[0] ?? "A").toUpperCase()}
            </AvatarFallback>
          </Avatar>
        </header>

        <main className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 md:p-6">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}
