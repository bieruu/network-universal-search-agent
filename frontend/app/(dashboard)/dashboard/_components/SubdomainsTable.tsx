"use client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, THead, TRow, TH, TD } from "@/components/ui/table";
import type { ScanResult } from "@/lib/api";
import { getSubdomains } from "@/lib/scan-shape";
import { TERM, plural, termNote } from "@/lib/terms";

/** Display cap. Never applied silently — the card says how many it hid. */
const MAX_ROWS = 100;

export default function SubdomainsTable({
  scan,
  loading,
}: {
  scan: ScanResult | null;
  loading: boolean;
}) {
  const rows = getSubdomains(scan?.results);
  const shown = rows.slice(0, MAX_ROWS);
  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle>{TERM.subdomains.label}</CardTitle>
        <CardDescription>
          {rows.length === 0
            ? "Names found in the public log of certificates issued for this domain (crt.sh)."
            : `${rows.length} ${plural(rows.length, "name", "names")} found, from the public log of certificates issued for this domain.`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-24" />
        ) : rows.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-neutral-500">
            {scan?.errors.some((e) => e.source === "crtsh")
              ? "We could not search the certificate logs, so we have nothing here — not a confirmation that there are none. See the source error above."
              : "No subdomains found."}
          </p>
        ) : (
          <>
            <div className="max-h-[320px] overflow-auto">
              <Table>
                <THead>
                  <TRow>
                    <TH title={termNote("subdomains")}>{TERM.subdomains.label}</TH>
                    <TH title={termNote("issuer")}>{TERM.issuer.label}</TH>
                    <TH>Valid until</TH>
                  </TRow>
                </THead>
                <tbody>
                  {shown.map((r) => (
                    <TRow key={r.subdomain}>
                      <TD className="font-mono">{r.subdomain}</TD>
                      <TD>{r.issuer ?? "—"}</TD>
                      <TD>{r.not_after ?? "—"}</TD>
                    </TRow>
                  ))}
                </tbody>
              </Table>
            </div>
            {rows.length > MAX_ROWS && (
              <p className="mt-2 text-xs opacity-60">
                Showing the first {MAX_ROWS} of {rows.length.toLocaleString("en-US")} names found. Narrow the
                target to see the rest.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
