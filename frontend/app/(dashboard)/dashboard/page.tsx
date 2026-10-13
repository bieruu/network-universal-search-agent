"use client";
import { useCallback, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchScan, pollScan, startScan, type ScanResult } from "@/lib/api";
import { scanStatusLabel, sourceFailureCount } from "@/lib/scan-status";
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
      setError(
        e instanceof Error && e.message
          ? e.message
          : "We could not start that search. Check the target and try again.",
      );
    } finally {
      setPolling(false);
      setLoading(false);
    }
  }, []);

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
      {/* 1 — Search */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle>New scan</CardTitle>
              <CardDescription>
                Reads public sources only — nothing is sent to the target and nothing on it is touched.
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

      {/* 3 — Charts side by side */}
      <div className="grid gap-4 lg:grid-cols-2">
        <PortsChart scan={scan} />
        <RiskTrendChart target={target} />
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

      {/* 6 — History + findings side by side */}
      <div className="grid gap-4 lg:grid-cols-2">
        <HistoryList onSelect={reopen} limit={5} />
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
    </AppShell>
  );
}
