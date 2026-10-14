"use client";
import { useCallback, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchScan, pollScan, startScan, type ScanResult } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import {
  GUEST_BANNER_DESCRIPTION,
  GUEST_BANNER_TITLE,
  GUEST_HISTORY_LOCKED,
  GUEST_TREND_LOCKED,
  guestQuotaMessage,
  isGuestSession,
} from "@/lib/guest";
import { scanStatusLabel, sourceFailureCount } from "@/lib/scan-status";
import { UserFacingError } from "@/lib/user-errors";
import { latestFindings, statsFromScan } from "@/components/ui/app-1-utils/app-1-data";
import TargetSearch from "./_components/TargetSearch";
import ScanStatus from "./_components/ScanStatus";
import CardWash from "./_components/card-wash";
import PortsChart from "./_components/PortsChart";
import RiskTrendChart from "./_components/RiskTrendChart";
import PortsTable from "./_components/PortsTable";
import SubdomainsTable from "./_components/SubdomainsTable";
import ThreatHistoryCard from "./_components/ThreatHistoryCard";
import WhoisCard from "./_components/WhoisCard";
import VulnerabilitiesCard from "./_components/VulnerabilitiesCard";
import HistoryList from "./_components/HistoryList";
import ExportFindingsCard from "./_components/ExportFindingsCard";
import AppShell from "./_components/app-shell";

/**
 * `errors[]` reaches the browser as `{source, message}` straight from the
 * providers — "shodan: timeout". Those badges told the analyst nothing they
 * could act on and handed them an exception string from a third party. We name
 * the source in words and say what the gap means for their results; the detail
 * stays in the console.
 */
const SOURCE_NAMES: Record<string, string> = {
  shodan: "Internet scan data (Shodan)",
  crtsh: "Certificate logs (crt.sh)",
  whois: "Domain registration records",
  nvd: "The vulnerability database (NVD)",
};

function sourceName(id: string): string {
  const key = id.toLowerCase();
  return SOURCE_NAMES[key] ?? "A data source";
}

export default function DashboardPage() {
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  // True only while a scan is actually being polled. `loading` cannot stand in
  // for it: it is also true while a saved scan is being reopened from history,
  // and the status badge's live dot must report polling, not every spinner.
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  // Read from the client, after the shell has rendered: the guest banner must
  // not be server-rendered into cacheable HTML either way, and `isPending` (not
  // the absence of `data`) is what keeps it off-screen until Better Auth has
  // actually answered — `data` is null while the check is in flight too.
  const sessionState = authClient.useSession();
  const guest = isGuestSession(sessionState);
  // While Better Auth has not answered, nobody is "not a guest" yet: rendering
  // the account-only cards now would fire /api/history (and /api/trend once a
  // target is set) on behalf of a visitor who is about to be told they have no
  // history — one wasted request plus an error badge flash. Pending = skeleton.
  const authPending = sessionState.isPending;

  const run = useCallback(async (t: string, force: boolean) => {
    setLoading(true);
    setError(null);
    setTarget(t);
    try {
      const { scan_id } = await startScan(t, force);
      setPolling(true);
      const done = await pollScan(scan_id, { onUpdate: setScan });
      setScan(done);
    } catch (e: unknown) {
      // A guest's 429 is a spent quota, not a broken account. lib/user-errors.ts
      // maps 429 to account copy on purpose (it is the general path), so the one
      // surface that knows there is no account replaces it here.
      const quota = e instanceof UserFacingError && e.status === 429;
      setError(
        quota && guest
          ? guestQuotaMessage()
          : e instanceof Error && e.message
            ? e.message
            : "We could not start that search. Check the target and try again.",
      );
    } finally {
      setPolling(false);
      setLoading(false);
    }
  }, [guest]);

  const reopen = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const s = await fetchScan(id);
      setScan(s);
      setTarget(s.target);
    } catch (e: unknown) {
      setError(
        e instanceof Error && e.message
          ? e.message
          : "We could not open that saved scan. It may have been removed — try again in a moment.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  const stats = statsFromScan(scan);
  const findings = latestFindings(scan);
  const sourceErrors = scan?.errors ?? [];

  return (
    <AppShell target={target}>
      {/* 0 — Guest banner. Above everything because it explains the two limits
          the visitor is about to meet: the daily quota and the absent history.
          Rendered only once Better Auth has said there is no session, so a
          signed-in analyst never sees it flash. */}
      {guest && (
        <Card aria-label="guest mode">
          <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
            <div className="space-y-1.5">
              <CardTitle className="flex items-center gap-2 text-base">
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 rounded-full bg-accent motion-safe:animate-blip"
                />
                {GUEST_BANNER_TITLE}
              </CardTitle>
              <CardDescription>{GUEST_BANNER_DESCRIPTION}</CardDescription>
            </div>
            <Link
              href="/sign-in"
              className={`${buttonClasses("accent", "sm")} shrink-0`}
            >
              Sign in
            </Link>
          </CardHeader>
        </Card>
      )}

      {/* 1 — Search */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle>New scan</CardTitle>
              <CardDescription>
                Reads public records only — no packets are sent to your target&apos;s host. DNS queries are resolved by our backend and are visible to the target&apos;s authoritative nameservers.
              </CardDescription>
            </div>
            {target && (
              <Button variant="outline" disabled={loading} onClick={() => run(target, true)}>
                Re-scan
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <TargetSearch onSubmit={run} loading={loading} />
          <div className="mt-3">
            <ScanStatus scan={scan} polling={polling} />
          </div>
          {error && (
            <div className="mt-2">
              <Badge variant="destructive">{error}</Badge>
            </div>
          )}
          {sourceErrors.length > 0 && (
            <div className="mt-2 flex flex-col gap-1.5">
              <p className="text-xs text-warning">{sourceFailureCount(sourceErrors.length)}</p>
              <ul className="flex flex-wrap gap-1.5" aria-label="sources that did not answer">
                {sourceErrors.map((e, i) => (
                  <li key={`${e.source}-${i}`}>
                    <Badge variant="outline">{sourceName(e.source)}</Badge>
                  </li>
                ))}
              </ul>
              <p className="text-xs opacity-60">
                Anything missing below was not checked, not confirmed absent. Run the scan again to retry.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 2 — Stats: one instrument strip, not four gradient cards. The strip is
          divided by hairlines (gap-px over a bordered surface) rather than by
          four separate card borders, and it carries no icon chips and no hover
          state — three of the four old cards advertised a hover they could not
          honour. `tabular-nums` stays: these numbers change in place, and
          proportional figures would jitter the whole strip as they did. */}
      <div
        className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-btn-border bg-btn-border lg:grid-cols-4"
        aria-label="scan stats"
      >
        {loading
          ? Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-[104px] rounded-none" />
            ))
          : stats.map((s, i) => (
              <div key={s.key} className="relative overflow-hidden bg-background/95 p-4">
                <CardWash index={i} />
                <p className="relative text-sm text-slate-600 dark:text-neutral-400">{s.label}</p>
                <p className="relative mt-1 font-mono text-3xl font-bold tabular-nums">{s.value}</p>
                <p className="relative mt-1 truncate text-xs text-slate-500 dark:text-neutral-500">{s.hint}</p>
              </div>
            ))}
      </div>

      {/* 3 — Charts side by side. The trend is account-scoped (it reads rows
          from history), so a guest gets the reason instead of a chart that
          would 401 — a dark chart with no data reads as "your trend is empty",
          which is not what happened. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <PortsChart scan={scan} />
        {authPending ? (
          <PendingCard title="Risk trend" />
        ) : guest ? (
          <Card aria-label="risk trend unavailable in guest mode">
            <CardHeader>
              <CardTitle>Risk trend</CardTitle>
              <CardDescription>{GUEST_TREND_LOCKED}</CardDescription>
            </CardHeader>
            <CardContent>
              <Link href="/sign-in" className={buttonClasses("outline", "sm")}>
                Sign in
              </Link>
            </CardContent>
          </Card>
        ) : (
          <RiskTrendChart target={target} />
        )}
      </div>

      {/* 4 — Open ports & services, full width */}
      <PortsTable scan={scan} loading={loading} error={null} />

      {/* 4b — CVE evidence, full width */}
      <VulnerabilitiesCard scan={scan} loading={loading} />

      {/* 4c — Threat intelligence history. Renders only when the vulnerability tab
          came back empty, which is exactly when this card has something honest
          to add; a populated CVE list means history never ran. */}
      <ThreatHistoryCard history={scan?.results.history} loading={loading} />

      {/* 5 — Subdomains + WHOIS side by side */}
      <div className="grid gap-4 lg:grid-cols-2">
        <SubdomainsTable scan={scan} loading={loading} />
        <WhoisCard scan={scan} loading={loading} />
      </div>

      {/* 6 — History + findings side by side. /api/history is account-only
          (require_user), so a guest gets the reason rather than a request that
          answers 401 and renders as an error badge next to a scan they can see.
          While auth is still pending nobody is a guest yet, so the slot holds a
          non-fetching skeleton instead of mounting HistoryList. */}
      <div className="grid gap-4 lg:grid-cols-2">
        {authPending ? (
          <PendingCard title="History" />
        ) : guest ? (
          <Card aria-label="history unavailable in guest mode">
            <CardHeader>
              <CardTitle>History</CardTitle>
              <CardDescription>{GUEST_HISTORY_LOCKED}</CardDescription>
            </CardHeader>
            <CardContent>
              <Link href="/sign-in" className={buttonClasses("outline", "sm")}>
                Sign in to keep scans
              </Link>
            </CardContent>
          </Card>
        ) : (
          <HistoryList onSelect={reopen} limit={5} />
        )}
        <Card className="relative flex flex-col overflow-hidden">
          <CardWash index={2} />
          <CardHeader className="relative">
            <CardTitle>Latest findings</CardTitle>
            <CardDescription>
            {scan
              ? `${scan.target} · ${scanStatusLabel(scan.status)}`
              : "Once you scan a target, its headline findings appear here."}
          </CardDescription>
          </CardHeader>
          <CardContent className="relative">
            {!scan ? (
              <p className="text-sm text-slate-500 dark:text-neutral-500">No findings yet — run a scan.</p>
            ) : findings.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-neutral-500">No findings in this scan.</p>
            ) : (
              <ul className="flex flex-col gap-1.5 text-sm">
                {findings.map((f) => (
                  <li key={f} className="truncate font-mono text-slate-600 dark:text-neutral-400">
                    {f}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 7 — Export. Last, because it is a verb on everything above it: the
          file is built from the scan this page is already showing, so it cannot
          be offered before there is something to show. */}
      <ExportFindingsCard scan={scan} loading={loading} />
    </AppShell>
  );
}

/**
 * Holding pattern for a card whose owner is not known yet.
 *
 * Deliberately renders NOTHING that fetches. `HistoryList` calls /api/history
 * and `RiskTrendChart` calls /api/trend the moment they mount, and neither has
 * an answer for a visitor whose session has not been checked: mounting them
 * during `isPending` buys one doomed request (401, or a 502 while the backend
 * sleeps) and an error badge that disappears as soon as Better Auth answers.
 * A skeleton is the honest state — "we do not know whose history this is".
 */
function PendingCard({ title }: { title: string }) {
  return (
    <Card aria-label={`${title.toLowerCase()} loading`}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <Skeleton className="h-32 w-full" aria-hidden="true" />
      </CardContent>
    </Card>
  );
}
