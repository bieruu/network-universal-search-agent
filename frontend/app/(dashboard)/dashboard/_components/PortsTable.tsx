"use client";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, THead, TRow, TH, TD } from "@/components/ui/table";
import type { ScanResult } from "@/lib/api";

export default function PortsTable({
  scan,
  loading,
  error,
}: {
  scan: ScanResult | null;
  loading: boolean;
  error: string | null;
}) {
  const services = scan?.results.shodan?.services ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Open ports &amp; services</CardTitle>
        <CardDescription>
          {scan?.results.shodan?.ip ? `Host ${scan.results.shodan.ip} · ` : ""}
          {services.length} service{services.length === 1 ? "" : "s"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-24" />
        ) : error ? (
          <Badge variant="destructive">{error}</Badge>
        ) : services.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-neutral-500">
            {scan?.errors.some((e) => e.source === "shodan")
              ? "Shodan returned no data for this host (CDN/WAF IPs often have none) — see the source error above."
              : "No ports found."}
          </p>
        ) : (
          <div className="max-h-[320px] overflow-auto">
            <Table>
              <THead>
                <TRow>
                  <TH>Port</TH>
                  <TH>Product</TH>
                  <TH>Version</TH>
                  <TH>Banner</TH>
                </TRow>
              </THead>
              <tbody>
                {services.map((s) => (
                  <TRow key={s.port}>
                    <TD className="font-mono">{s.port}</TD>
                    <TD>{s.product ?? "—"}</TD>
                    <TD>{s.version ?? "—"}</TD>
                    <TD className="max-w-xs truncate" title={s.banner ?? ""}>
                      {s.banner ? s.banner.slice(0, 120) : "—"}
                    </TD>
                  </TRow>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
