"use client";
import { useCallback, useState } from "react";
import { Bug, Globe, Network, Server } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchScan, pollScan, startScan, type ScanResult } from "@/lib/api";
import { latestFindings, statsFromScan } from "@/components/ui/app-1-utils/app-1-data";
import TargetSearch from "./_components/TargetSearch";
import ScanStatus from "./_components/ScanStatus";
import PortsChart from "./_components/PortsChart";
import RiskTrendChart from "./_components/RiskTrendChart";
import PortsTable from "./_components/PortsTable";
import SubdomainsTable from "./_components/SubdomainsTable";
import ThreatHistoryCard from "./_components/ThreatHistoryCard";
import WhoisCard from "./_components/WhoisCard";
import VulnerabilitiesCard from "./_components/VulnerabilitiesCard";
import HistoryList from "./_components/HistoryList";
import AppShell from "./_components/app-shell";

const STAT_ICONS = { ports: Network, services: Server, vulns: Bug, subs: Globe } as const;

export default function DashboardPage() {
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);

  const run = useCallback(async (t: string, force: boolean) => {
    setLoading(true);
    setError(null);
    setTarget(t);
    try {
      const { scan_id } = await startScan(t, force);
      const done = await pollScan(scan_id, { onUpdate: setScan });
      setScan(done);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Scan failed");
    } finally {
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
      setError(e instanceof Error ? e.message : "Failed to load scan");
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
              <CardDescription>Passive sources only — Shodan, crt.sh, WHOIS</CardDescription>
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
            <ScanStatus scan={scan} />
          </div>
          {error && (
            <div className="mt-2">
              <Badge variant="destructive">{error}</Badge>
            </div>
          )}
          {sourceErrors.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1.5" aria-label="source errors">
              {sourceErrors.map((e) => (
                <li key={e.source}>
                  <Badge variant="destructive">
                    {e.source}: {e.message}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* 2 — Stats */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="scan stats">
        {loading
          ? Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)
          : stats.map((s) => {
              const Icon = STAT_ICONS[s.key as keyof typeof STAT_ICONS] ?? Network;
              return (
                <Card key={s.key} className="relative overflow-hidden transition-colors hover:border-accent/40">
                  <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-gradient-to-br from-accent/10 via-transparent to-transparent" />
                  <CardHeader className="relative flex-row items-center justify-between space-y-0">
                    <CardTitle className="text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-neutral-400">{s.label}</CardTitle>
                    <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">
                      <Icon size={18} strokeWidth={2} aria-hidden="true" />
                    </span>
                  </CardHeader>
                  <CardContent className="relative">
                    <p className="font-mono text-3xl font-bold tabular-nums">{s.value}</p>
                    <CardDescription className="mt-1 truncate">{s.hint}</CardDescription>
                  </CardContent>
                </Card>
              );
            })}
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
        <Card className="flex flex-col">
          <CardHeader>
            <CardTitle>Latest findings</CardTitle>
            <CardDescription>{scan ? `${scan.target} · ${scan.status}` : "From the active scan"}</CardDescription>
          </CardHeader>
          <CardContent>
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
