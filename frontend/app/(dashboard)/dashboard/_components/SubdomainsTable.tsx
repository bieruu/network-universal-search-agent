"use client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle>Subdomains</CardTitle>
        <CardDescription>
          {rows.length} subdomain{rows.length === 1 ? "" : "s"} found
          {scan?.results.crtsh?.source ? ` · via ${scan.results.crtsh.source}` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-24" />
        ) : rows.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-neutral-500">
            {scan?.errors.some((e) => e.source === "crtsh")
              ? "Certificate transparency providers returned no data — see the source error above."
              : "No subdomains found."}
          </p>
        ) : (
          <div className="max-h-[320px] overflow-auto">
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
                    <TD className="font-mono">{r.subdomain}</TD>
                    <TD>{r.issuer ?? "—"}</TD>
                    <TD>{r.not_after ?? "—"}</TD>
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
