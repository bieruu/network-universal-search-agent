"use client";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, THead, TRow, TH, TD } from "@/components/ui/table";
import { buttonClasses } from "@/components/ui/button";
import type { ScanResult } from "@/lib/api";
import { TERM, plural, termNote } from "@/lib/terms";
import {
  filterSubdomainRows,
  MAX_ROWS,
  normalizeSubdomains,
  subdomainFilterLabel,
  subdomainValidityLabel,
  subdomainValidityNote,
  subdomainsVisibility,
  type SubdomainFilter,
  type SubdomainValidity,
} from "@/lib/subdomains-view";

const FILTERS: SubdomainFilter[] = ["all", "active", "expired", "unknown"];

const VALIDITY_BADGE: Record<SubdomainValidity, { variant: "default" | "outline" | "secondary"; className?: string }> = {
  // An expired certificate is not an alarm: the name is still in the log and
  // the operator asked for what the log says. Amber, not red.
  active: { variant: "secondary" },
  expired: { variant: "outline", className: "text-warning" },
  unknown: { variant: "outline" },
};

const VALIDITY_TITLE: Record<SubdomainFilter, string> = {
  all: "Every name the certificate log returned for this domain.",
  active: "Names whose certificate is inside its validity window now.",
  expired: "Names whose certificate has passed its expiry date. Shown with a label, never hidden.",
  unknown: "Names whose validity dates could not be read, or whose certificate has not started yet.",
};

function countsFor(view: { unique: number; active: number; expired: number; unknown: number }, filter: SubdomainFilter): number {
  switch (filter) {
    case "active":
      return view.active;
    case "expired":
      return view.expired;
    case "unknown":
      return view.unknown;
    default:
      return view.unique;
  }
}

export default function SubdomainsTable({
  scan,
  loading,
}: {
  scan: ScanResult | null;
  loading: boolean;
}) {
  const [filter, setFilter] = useState<SubdomainFilter>("all");
  const [requestedPage, setRequestedPage] = useState(0);

  // Cleansed once per scan, not per render: the table and the export both read
  // this view, so a name cannot be labelled here and unlabelled there.
  const view = useMemo(() => normalizeSubdomains(scan?.results), [scan?.results]);
  const visibility = subdomainsVisibility(view, filter, requestedPage);
  const filtered = filterSubdomainRows(view.rows, filter);
  const shown = filtered.slice(visibility.page * MAX_ROWS, visibility.page * MAX_ROWS + MAX_ROWS);

  const choose = (next: SubdomainFilter) => {
    setFilter(next);
    setRequestedPage(0);
  };

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle>{TERM.subdomains.label}</CardTitle>
        <CardDescription>
          {view.unique === 0
            ? "Names found in the public log of certificates issued for this domain (crt.sh)."
            : `${view.reported.toLocaleString("en-US")} ${plural(view.reported, "entry", "entries")} in the certificate log reduced to ${view.unique.toLocaleString("en-US")} ${plural(view.unique, "name", "names")}: ${view.active.toLocaleString("en-US")} active, ${view.expired.toLocaleString("en-US")} expired, ${view.unknown.toLocaleString("en-US")} with dates we could not read.`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-24" />
        ) : view.unique === 0 ? (
          <p className="text-sm text-slate-500 dark:text-neutral-500">
            {scan?.errors.some((e) => e.source === "crtsh")
              ? "We could not search the certificate logs, so we have nothing here — not a confirmation that there are none. See the source error above."
              : "No subdomains found."}
          </p>
        ) : (
          <>
            {/*
              The filter bar states each option's count, so "Expired 15" can
              never silently become "Expired 0" because the filter was left on.
            */}
            <div className="mb-3 flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter names by certificate validity">
              {FILTERS.map((f) => (
                <button
                  key={f}
                  type="button"
                  aria-pressed={filter === f}
                  title={VALIDITY_TITLE[f]}
                  onClick={() => choose(f)}
                  className={buttonClasses(filter === f ? "accent" : "outline", "sm")}
                >
                  {subdomainFilterLabel(f)}
                  <span className="ml-1.5 tabular-nums opacity-70">{countsFor(view, f).toLocaleString("en-US")}</span>
                </button>
              ))}
            </div>

            {visibility.visible === 0 ? (
              <p className="text-sm text-slate-500 dark:text-neutral-500">
                {visibility.rowNote} {visibility.honestyNote}
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
                        <TH title={subdomainValidityNote("active")}>Certificate</TH>
                      </TRow>
                    </THead>
                    <tbody>
                      {shown.map((r) => {
                        const badge = VALIDITY_BADGE[r.validity];
                        return (
                          <TRow key={r.subdomain}>
                            <TD className="font-mono">
                              {r.subdomain}
                              {r.merged > 1 && (
                                <span className="ml-1.5 text-xs opacity-60" title={`${r.merged} entries in the certificate log carried this name; they were merged into one row.`}>
                                  ({r.merged} merged)
                                </span>
                              )}
                            </TD>
                            <TD>{r.issuer ?? "—"}</TD>
                            <TD>{r.not_after ?? "—"}</TD>
                            <TD>
                              <Badge variant={badge.variant} className={badge.className} title={subdomainValidityNote(r.validity)}>
                                {subdomainValidityLabel(r.validity)}
                              </Badge>
                            </TD>
                          </TRow>
                        );
                      })}
                    </tbody>
                  </Table>
                </div>

                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs opacity-60" aria-live="polite">
                    {visibility.rowNote}
                  </p>
                  {visibility.pages > 1 && (
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        className={buttonClasses("outline", "sm")}
                        disabled={visibility.page === 0}
                        onClick={() => setRequestedPage(visibility.page - 1)}
                      >
                        Previous
                      </button>
                      <span className="px-1 text-xs tabular-nums opacity-70">
                        Page {visibility.page + 1} of {visibility.pages}
                      </span>
                      <button
                        type="button"
                        className={buttonClasses("outline", "sm")}
                        disabled={visibility.page >= visibility.pages - 1}
                        onClick={() => setRequestedPage(visibility.page + 1)}
                      >
                        Next
                      </button>
                    </div>
                  )}
                </div>

                {visibility.honestyNote && (
                  <p className="mt-2 text-xs opacity-60">{visibility.honestyNote}</p>
                )}
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
