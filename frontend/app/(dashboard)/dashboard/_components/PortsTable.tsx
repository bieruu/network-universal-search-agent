"use client";
import { Badge } from "@/components/ui/badge";
import { Card, CardTitle } from "@/components/ui/card";
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
  return (
    <Card>
      <CardTitle>Open ports &amp; services</CardTitle>
      {loading ? (
        <Skeleton className="mt-2 h-24" />
      ) : error ? (
        <Badge variant="destructive">{error}</Badge>
      ) : !scan?.results.shodan?.services?.length ? (
        <p className="mt-2 text-sm opacity-60">No ports found.</p>
      ) : (
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
            {scan.results.shodan.services.map((s) => (
              <TRow key={s.port}>
                <TD>{s.port}</TD>
                <TD>{s.product ?? "—"}</TD>
                <TD>{s.version ?? "—"}</TD>
                <TD className="max-w-xs truncate" title={s.banner ?? ""}>
                  {s.banner ? s.banner.slice(0, 120) : "—"}
                </TD>
              </TRow>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
