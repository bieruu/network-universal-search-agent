"use client";
import { Badge } from "@/components/ui/badge";
import { Card, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { ScanResult } from "@/lib/api";
import { getCveEvidence, getSubdomainCount } from "@/lib/scan-shape";

export default function OverviewCards({
  scan,
  loading,
  error,
}: {
  scan: ScanResult | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading) {
    return (
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5" aria-label="overview loading">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
    );
  }
  if (error) return <Badge variant="destructive">{error}</Badge>;
  if (!scan) return <p className="text-sm opacity-60">Run a scan to see overview.</p>;
  const ports = scan.results.shodan?.ports?.length ?? 0;
  const services = scan.results.shodan?.services?.length ?? 0;
  const evidence = getCveEvidence(scan.results);
  const subs = getSubdomainCount(scan.results);
  const cards: Array<[string, string, string?]> = [
    ["Risk score", scan.risk_score != null ? String(scan.risk_score) : "—"],
    ["Open ports", String(ports)],
    ["Services", String(services)],
    ["Vulns", evidence.count == null ? "—" : String(evidence.count), evidence.hint],
    ["Subdomains", String(subs)],
  ];
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
      {cards.map(([k, v, hint]) => (
        <Card key={k}>
          <CardTitle>{k}</CardTitle>
          <p className="mt-1 text-2xl font-bold">{v}</p>
          {hint && k === "Vulns" && <p className="mt-1 text-xs opacity-60">{hint}</p>}
        </Card>
      ))}
    </div>
  );
}
