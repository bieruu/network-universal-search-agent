"use client";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, THead, TRow, TH, TD } from "@/components/ui/table";
import {
  SAFETY_CAVEAT,
  columnHeading,
  headlineBadge,
  parseThreatHistory,
  statusBadge,
  type HistoryRow,
  type HistorySource,
} from "@/lib/threat-history-shape";
import { sourceFailureCount } from "@/lib/scan-status";

/**
 * Threat-intelligence history, shown only when the orchestrator ran the fallback
 * chain because the vulnerability tab had no CVE data.
 *
 * Three states, deliberately distinct (see lib/threat-history-shape.ts):
 *   - records found  → rows, with the reason this card ran above them
 *   - no records     → the NORMAL healthy outcome; muted copy, never a red badge,
 *                      and never the words "safe" or "clean"
 *   - partial        → some source was unreachable/unconfigured, so "no records"
 *                      would overstate what was checked
 *
 * Every value below is rendered as a text child. `banner` is attacker-written,
 * so React escaping is the only thing standing between it and the DOM; this
 * file never reaches for a raw-HTML sink.
 */
export function ThreatHistoryCard({
  history,
  loading = false,
}: {
  /** Raw `results.history` from the scan payload: may be absent, null, or malformed. */
  history: unknown;
  /** Optional so a caller that only passes `history` still compiles. */
  loading?: boolean;
}) {
  const parsed = parseThreatHistory(history);

  if (!loading && !parsed) return null;

  if (!parsed) {
    return (
      <Card className="flex flex-col">
        <CardHeader>
          <CardTitle>Threat &amp; incident history</CardTitle>
          <CardDescription>Past incidents and threat activity recorded for this target.</CardDescription>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-24" />
        </CardContent>
      </Card>
    );
  }

  const { summary } = parsed;
  const headline = headlineBadge(summary.outcome);
  // The payload note carries the "absence of CVEs is not proof of safety" warning;
  // keep our own caveat on the non-finding states so it can never be dropped.
  const caveat = [parsed.note, summary.outcome === "findings" ? "" : SAFETY_CAVEAT].filter(Boolean).join(" ");

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle>Threat &amp; incident history</CardTitle>
        <CardDescription>
          {summary.findingCount > 0
            ? `${summary.findingCount.toLocaleString("en-US")} ${summary.findingCount === 1 ? "record" : "records"} across the sources below, for this target.`
            : "Past incidents and threat activity recorded for this target."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4">
          {/* `triggerReason` is deliberately not rendered: it is an internal
              reason code describing why this fallback ran, which means nothing
              to a reader and exposes how the search is put together. */}
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={headline.variant}>{headline.text}</Badge>
              <p className="text-sm font-medium">{parsed.headline}</p>
            </div>
            <p className="text-sm text-slate-500 dark:text-neutral-500">{parsed.detail}</p>
            {caveat && <p className="text-xs opacity-60">{caveat}</p>}
          </div>

          {parsed.sources.map((source) => (
            <SourceSection key={source.key} source={source} />
          ))}

          {parsed.errors.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <p className="text-xs text-warning">{sourceFailureCount(parsed.errors.length)}</p>
              <p className="text-xs opacity-60">
                Treat the sources above as partial coverage — a gap here is not a clean result.
              </p>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function SourceSection({ source }: { source: HistorySource }) {
  const badge = statusBadge(source.outcome);
  const headers = (source.rows[0]?.cells ?? []).map((c) => columnHeading(c.label));
  return (
    <section className="flex flex-col gap-1.5" aria-label={source.label}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">{source.label}</h3>
        <Badge variant={badge.variant}>{badge.text}</Badge>
        {source.windowDays !== null && (
          <span className="text-xs text-slate-500 dark:text-neutral-500">
            From the last {source.windowDays} days
          </span>
        )}
        {source.total !== null && source.total > source.rows.length && (
          <span className="text-xs text-slate-500 dark:text-neutral-500">
            {source.total.toLocaleString("en-US")} recorded in total
          </span>
        )}
      </div>
      <p className="text-sm text-slate-500 dark:text-neutral-500">{source.message}</p>
      {/*
        `source.note` is the source's own diagnostic ("HTTP 429 from …"). It stays
        on the parsed object for the console but is not shown: it is provider
        plumbing, and `message` above already says what it means for the result.
      */}
      {source.screenshotUrl && (
        <a
          href={source.screenshotUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="text-xs text-accent hover:underline"
        >
          See the most recent archived view of this page (urlscan.io)
        </a>
      )}
      {source.rows.length > 0 && (
        <div className="max-h-[320px] overflow-auto">
          <Table>
            <THead>
              <TRow>
                {headers.map((h) => (
                  <TH key={h.label} title={h.title || undefined}>
                    {h.label}
                  </TH>
                ))}
              </TRow>
            </THead>
            <tbody>
              {source.rows.map((row) => (
                <Row key={row.id} row={row} />
              ))}
            </tbody>
          </Table>
        </div>
      )}
      {source.truncationNote && <p className="text-xs opacity-60">{source.truncationNote}</p>}
    </section>
  );
}

function Row({ row }: { row: HistoryRow }) {
  return (
    <TRow>
      {row.cells.map((cell, i) => (
        <TD key={`${row.id}-${cell.label}-${i}`} className={cell.mono ? "max-w-xs font-mono text-xs" : undefined}>
          {cell.href ? (
            <a href={cell.href} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">
              {cell.value}
            </a>
          ) : (
            <span className={cell.mono ? "block truncate" : undefined} title={cell.mono ? cell.value : undefined}>
              {cell.value}
            </span>
          )}
          {cell.truncated && <span className="ml-1 opacity-60">(truncated)</span>}
        </TD>
      ))}
    </TRow>
  );
}

export default ThreatHistoryCard;