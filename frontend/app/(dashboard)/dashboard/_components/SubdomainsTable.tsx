"use client";
import { Card, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, THead, TRow, TH, TD } from "@/components/ui/table";
import type { ScanResult } from "@/lib/api";
import { getSubdomains } from "@/lib/scan-shape";

export default function SubdomainsTable({
  scan,
  loading,
}: {
  scan: ScanResult | null;
  loading: boolean;
}) {
  const rows = getSubdomains(scan?.results);
  return (
    <Card>
      <CardTitle>Subdomains (crt.sh)</CardTitle>
      {loading ? (
        <Skeleton className="mt-2 h-24" />
      ) : rows.length === 0 ? (
        <p className="mt-2 text-sm opacity-60">No subdomains found.</p>
      ) : (
        <Table>
          <THead>
            <TRow>
              <TH>Subdomain</TH>
              <TH>Issuer</TH>
              <TH>Expires</TH>
            </TRow>
          </THead>
          <tbody>
            {rows.slice(0, 100).map((r) => (
              <TRow key={r.subdomain}>
                <TD>{r.subdomain}</TD>
                <TD>{r.issuer ?? "—"}</TD>
                <TD>{r.not_after ?? "—"}</TD>
              </TRow>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
