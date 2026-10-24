"use client";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, THead, TRow, TH, TD } from "@/components/ui/table";
import type { NvdCveRow, ScanResult } from "@/lib/api";
import { cveTierView, nvdStatusView } from "@/lib/scan-status";
import { TERM, termNote } from "@/lib/terms";

/** Display cap. Applied visibly - the count of what was hidden is stated. */
const MAX_ROWS = 100;

export default function VulnerabilitiesCard({
  scan,
  loading,
}: {
  scan: ScanResult | null;
  loading: boolean;
}) {
  const nvd = scan?.results.nvd;

  const all: NvdCveRow[] =
    Array.isArray(nvd?.cve_rows) && nvd.cve_rows.length > 0
      ? nvd.cve_rows
      : Array.isArray(nvd?.cves)
        ? nvd.cves.map((c): NvdCveRow => ({ ...c, tier: "unverified", source: "NVD" }))
        : [];
  const rows = all.slice(0, MAX_ROWS);

  const view = nvdStatusView(nvd?.status);
  const keywordLeads = nvd?.status === "keyword_derived";

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle>{TERM.cves.label}</CardTitle>
        <CardDescription>
          {scan
            ? `${scan.target} · ${view.label}`
            : "Published vulnerabilities matched against what the host runs."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-24" />
        ) : !scan ? (
          <p className="text-sm text-fg-muted">Run a scan to see matching vulnerabilities.</p>
        ) : !nvd ? (
          <p className="text-sm text-fg-muted">
            We did not check this target against the vulnerability catalogue. That means unknown, not none.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={view.tone}>{view.label}</Badge>
              {nvd.truncated && (
                <span className="text-xs opacity-60">
                  More matches exist than we can show here.
                </span>
              )}
            </div>
            <p className="text-sm text-fg-muted">{view.detail}</p>

            {rows.length === 0 ? (
              <p className="text-sm text-fg-muted">
                {keywordLeads
                  ? "Nothing in the catalogue mentions the products we detected. That is a wording match only, not a clean result."
                  : "No published entry matched the product and version we detected here. Coverage beyond this check is still unknown."}
              </p>
            ) : (
              <div className="max-h-[320px] overflow-auto">
                <Table>
                  <THead>
                    <TRow>
                      <TH title={termNote("cves")}>{TERM.cves.short}</TH>
                      <TH title="How confident we are that this entry applies to this host.">Confidence</TH>
                      <TH>Severity</TH>
                      <TH title={termNote("cvss")}>{TERM.cvss.label}</TH>
                      <TH title={termNote("cpe")}>{TERM.cpe.label}</TH>
                      <TH>Source</TH>
                    </TRow>
                  </THead>
                  <tbody>
                    {rows.map((c) => {
                      const tier = cveTierView(c.tier);
                      return (
                        <TRow key={c.id}>
                          <TD className="font-mono">
                            <a
                              href={c.url ?? `https://nvd.nist.gov/vuln/detail/${c.id}`}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="text-accent-text hover:underline"
                            >
                              {c.id}
                            </a>
                          </TD>
                          <TD>
                            <Badge variant={tier.tone} title={tier.detail}>
                              {tier.label}
                            </Badge>
                          </TD>
                          <TD>{c.severity ?? "-"}</TD>
                          <TD className="font-mono">{c.cvss != null ? `${c.cvss}/10` : "-"}</TD>
                          <TD
                            className="max-w-xs truncate font-mono text-xs"
                            title={c.evidence_cpe ?? (c.keyword_derived ? "Matched on wording in a description" : "")}
                          >
                            {c.evidence_cpe ?? (c.keyword_derived ? "Wording match only" : "-")}
                          </TD>
                          <TD className="text-xs">{c.source ?? "-"}</TD>
                        </TRow>
                      );
                    })}
                  </tbody>
                </Table>
              </div>
            )}

            {all.length > MAX_ROWS && (
              <p className="text-xs opacity-60">
                Showing the first {MAX_ROWS} of {all.length.toLocaleString("en-US")} entries found.
              </p>
            )}

            {/*
              Analyst safety information, not decoration. It used to sit as two
              always-visible paragraphs under the table, where it was noise on
              every scan; it is still on the card, one click away, and the
              distinctions are unchanged.
            */}
            <details className="text-xs opacity-70">
              <summary className="cursor-pointer select-none">What do these labels mean?</summary>
              <div className="mt-2 flex flex-col gap-1.5">
                <p>
                  <strong>Confidence</strong> is how sure we are an entry applies, not how dangerous it is.
                </p>
                <p>
                  <strong>Confirmed match</strong> means the running product and version match the entry exactly.
                </p>
                <p>
                  <strong>Reported, unconfirmed</strong> means an index reported it but we could not confirm the
                  version.
                </p>
                <p>
                  <strong>Rejected</strong> means the vendor marked the entry rejected or disputed, and we never
                  count it.
                </p>
                <p>
                  <strong>{TERM.cvss.label}</strong> is the {TERM.cvss.short} severity score, 0 to 10;{" "}
                  <strong>{TERM.cpe.label}</strong> is the {TERM.cpe.short} identifier we matched.
                </p>
                <p>No match is not proof of safety: unknown is not zero.</p>
                {keywordLeads && (
                  <p>
                    These rows are leads, not findings, and none count toward the{" "}
                    {TERM.risk.label.toLowerCase()}.
                  </p>
                )}
              </div>
            </details>
          </div>
        )}
      </CardContent>
    </Card>
  );
}