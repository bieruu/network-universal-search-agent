"use client";
import { useCallback, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fetchScan, pollScan, startScan, type ScanResult } from "@/lib/api";
import TargetSearch from "./_components/TargetSearch";
import ScanStatus from "./_components/ScanStatus";
import OverviewCards from "./_components/OverviewCards";
import PortsTable from "./_components/PortsTable";
import SubdomainsTable from "./_components/SubdomainsTable";
import WhoisCard from "./_components/WhoisCard";
import PortsChart from "./_components/PortsChart";
import RiskTrendChart from "./_components/RiskTrendChart";
import HistoryList from "./_components/HistoryList";

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

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Dashboard</h1>
        {target && (
          <Button variant="outline" disabled={loading} onClick={() => run(target, true)}>
            Re-scan
          </Button>
        )}
      </div>
      <TargetSearch onSubmit={run} loading={loading} />
      <ScanStatus scan={scan} />
      {error && <Badge variant="destructive">{error}</Badge>}
      {scan?.errors.map((e) => (
        <Badge key={e.source} variant="destructive">
          {e.source}: {e.message}
        </Badge>
      ))}
      <OverviewCards scan={scan} loading={loading} error={null} />
      <div className="grid gap-4 md:grid-cols-2">
        <PortsChart scan={scan} />
        <RiskTrendChart target={target} />
      </div>
      <PortsTable scan={scan} loading={loading} error={null} />
      <SubdomainsTable scan={scan} loading={loading} />
      <WhoisCard scan={scan} loading={loading} />
      <HistoryList onSelect={reopen} />
    </main>
  );
}
