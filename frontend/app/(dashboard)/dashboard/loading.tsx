import { Skeleton } from "@/components/ui/skeleton";
import AppShell from "./_components/app-shell";

// Route-level fallback for /dashboard. Navigating from the landing page (or
// anywhere outside this segment) used to leave the previous page on screen
// until the client chunk and its data had arrived, which read as a dead link.
// Next renders this while the dashboard segment is loading, so the click has an
// immediate answer.
//
// The chrome is the real AppShell, not a copy: the sidebar, header and theme
// toggle are the parts that must not flash or shift, only the sections below
// them are pending. Section 1 (search) gets no progress hint — the form is the
// first thing the analyst wants, and a skeleton bar in its place looks like a
// broken input.
export default function DashboardLoading() {
  return (
    <AppShell target={null}>
      <div aria-busy="true" aria-label="Loading dashboard">
        {/* 1 — Search */}
        <div className="rounded-xl border bg-card text-card-foreground shadow-sm">
          <div className="flex flex-col gap-1.5 p-6">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-4 w-72 max-w-full" />
          </div>
          <div className="p-6 pt-0">
            <Skeleton className="h-9 w-full" />
          </div>
        </div>

        {/* 2 — Stats. Same instrument strip as the page (one hairline-divided
            band), so the loading state does not flash a layout the real page
            then replaces — that swap is exactly the "dead link" feel this
            fallback exists to avoid. */}
        <div
          className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-btn-border bg-btn-border lg:grid-cols-4"
          aria-label="scan stats"
        >
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[104px] rounded-none" />
          ))}
        </div>

        {/* 3 — Charts side by side */}
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-80 rounded-xl" />
          <Skeleton className="h-80 rounded-xl" />
        </div>

        {/* 4 — Open ports & services */}
        <Skeleton className="h-64 rounded-xl" />

        {/* 4b — CVE evidence */}
        <Skeleton className="h-40 rounded-xl" />

        {/* 4c — Threat intelligence history */}
        <Skeleton className="h-40 rounded-xl" />

        {/* 5 — Subdomains + WHOIS side by side */}
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-56 rounded-xl" />
          <Skeleton className="h-56 rounded-xl" />
        </div>

        {/* 6 — History + findings side by side */}
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-64 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
      </div>
    </AppShell>
  );
}
