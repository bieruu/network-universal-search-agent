"use client";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, THead, TRow, TH, TD } from "@/components/ui/table";
import type { ScanResult } from "@/lib/api";
import { TERM, plural, termNote } from "@/lib/terms";

/** Banners are attacker-written and can be long; the cut is always shown. */
const BANNER_PREVIEW_CHARS = 120;

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
  const ip = scan?.results.shodan?.ip;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{TERM.ports.label} &amp; {TERM.services.label.toLowerCase()}</CardTitle>
        <CardDescription>
          {services.length === 0
            ? `Read from Shodan, a public index of internet-wide scans.${ip ? ` Host ${ip}.` : ""}`
            : `${services.length} ${plural(services.length, "service", "services")} found${ip ? ` on ${ip}` : ""}, from Shodan's public internet index. Nothing was probed.`}
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
              ? "We have nothing for this host: Shodan and its public InternetDB fallback could not be reached. See the source error above."
              : "No open ports were found for this host."}
          </p>
        ) : (
          <div className="max-h-[320px] overflow-auto">
            <Table>
              <THead>
                <TRow>
                  <TH>Port</TH>
                  <TH title={TERM.services.note}>Product</TH>
                  <TH title={TERM.services.note}>Version</TH>
                  <TH title={termNote("banner")}>{TERM.banner.label}</TH>
                </TRow>
              </THead>
              <tbody>
                {services.map((s) => {
                  const banner = s.banner ?? "";
                  const cut = banner.length > BANNER_PREVIEW_CHARS;
                  return (
                    <TRow key={s.port}>
                      <TD className="font-mono">{s.port}</TD>
                      <TD>{s.product ?? "—"}</TD>
                      <TD>{s.version ?? "—"}</TD>
                      <TD className="max-w-xs truncate" title={banner || termNote("banner")}>
                        {banner ? (
                          <>
                            {banner.slice(0, BANNER_PREVIEW_CHARS)}
                            {cut && <span className="ml-1 opacity-60">(cut short)</span>}
                          </>
                        ) : (
                          "—"
                        )}
                      </TD>
                    </TRow>
                  );
                })}
              </tbody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
