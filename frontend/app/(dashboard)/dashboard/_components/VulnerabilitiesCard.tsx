"use client";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, THead, TRow, TH, TD } from "@/components/ui/table";
import type { NvdCveRow, ScanResult } from "@/lib/api";

const STATUS_COPY: Record<string, string> = {
  found: "Exact-CPE matches from NVD.",
  no_match: "NVD returned no vulnerable-configuration match for the observed CPEs. This is not proof the host is safe.",
  insufficient_evidence: "No valid CPE identifiers were observed, so NVD was not queried. This count is unknown — not 0.",
  unavailable: "NVD could not be reached. Shown CVEs are partial evidence — not 0.",
  // Filled by the keyword fallback, which only runs when the CPE path found
  // nothing. These rows are LEADS: the CVE's description mentions a term, which
  // is not evidence this host is affected. They never count toward the score.
  keyword_derived:
    "Keyword-derived leads: CVEs whose NVD description mentions a detected product term. NOT evidence this host is affected, and none of these count toward the risk score.",
};

export default function VulnerabilitiesCard({
  scan,
  loading,
}: {
  scan: ScanResult | null;
  loading: boolean;
}) {
  const nvd = scan?.results.nvd;
  const rows = (
    Array.isArray(nvd?.cve_rows) && nvd.cve_rows.length > 0
      ? nvd.cve_rows
      : Array.isArray(nvd?.cves)
        ? nvd.cves.map((c): NvdCveRow => ({ ...c, tier: "unverified", source: "NVD" }))
        : []
  ).slice(0, 100);
  const status = nvd?.status;
  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle>Vulnerabilities</CardTitle>
        <CardDescription>
          {scan ? `${scan.target} · ${status ?? "NVD not checked"}` : "CVE evidence from Shodan + NVD"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-24" />
        ) : !scan ? (
          <p className="text-sm text-slate-500 dark:text-neutral-500">Run a scan to see CVE evidence.</p>
        ) : !nvd ? (
          <p className="text-sm text-slate-500 dark:text-neutral-500">NVD enrichment did not run for this scan.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {status === "unavailable" && <Badge variant="destructive">NVD unavailable — counts are partial, not zero.</Badge>}
            {status === "insufficient_evidence" && (
              <Badge variant="secondary">No CPE to check — CVE coverage unknown, not zero.</Badge>
            )}
            {status === "keyword_derived" && (
              <Badge variant="outline">
                Keyword leads only — investigate, do not treat as confirmed.
              </Badge>
            )}
            <p className="text-sm text-slate-500 dark:text-neutral-500">{STATUS_COPY[status ?? ""] ?? ""}</p>
            {nvd.note && <p className="text-xs opacity-60">{nvd.note}</p>}
            {rows.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-neutral-500">
                {status === "found"
                  ? "No CVE rows returned."
                  : status === "keyword_derived"
                    ? "The keyword fallback ran and found no CVEs mentioning the detected product terms."
                    : "No CVEs matched the observed evidence."}
              </p>
            ) : (
              <div className="max-h-[320px] overflow-auto">
                <Table>
                  <THead>
                    <TRow>
                      <TH>CVE</TH>
                      <TH>Tier</TH>
                      <TH>Severity</TH>
                      <TH>CVSS</TH>
                      <TH>Evidence CPE</TH>
                      <TH>Source</TH>
                    </TRow>
                  </THead>
                  <tbody>
                    {rows.map((c) => (
                      <TRow key={c.id}>
                        <TD className="font-mono">
                          <a
                            href={c.url ?? `https://nvd.nist.gov/vuln/detail/${c.id}`}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="text-accent hover:underline"
                          >
                            {c.id}
                          </a>
                        </TD>
                        <TD>
                          <Badge
                            variant={
                              c.tier === "verified"
                                ? "default"
                                : c.tier === "rejected"
                                  ? "destructive"
                                  : "secondary"
                            }
                          >
                            {c.tier ?? "unverified"}
                          </Badge>
                        </TD>
                        <TD>{c.severity ?? "—"}</TD>
                        <TD className="font-mono">{c.cvss ?? "—"}</TD>
                        <TD className="max-w-xs truncate font-mono text-xs" title={c.evidence_cpe ?? ""}>
                          {c.evidence_cpe ?? (c.keyword_derived ? "keyword" : "—")}
                        </TD>
                        <TD className="text-xs">{c.source ?? "—"}</TD>
                      </TRow>
                    ))}
                  </tbody>
                </Table>
              </div>
            )}
            {nvd.truncated && (
              <p className="text-xs opacity-60">Results truncated — refine CPE evidence to narrow matches.</p>
            )}
            <p className="text-xs opacity-60">
              Tiers: verified = NVD CPE-exact or cross-checked, unverified = reported by Shodan but not
              confirmed against NVD, rejected = NVD Rejected/Disputed (shown, not scored). No match is
              not proof of safety.
            </p>
            {status === "keyword_derived" && (
              <p className="text-xs opacity-60">
                Keyword rows are leads to investigate: the CVE description mentions a detected product
                term, which is not confirmation this host is affected. They are never scored.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
