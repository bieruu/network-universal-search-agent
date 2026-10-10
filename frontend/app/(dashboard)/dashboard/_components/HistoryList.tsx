"use client";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchHistory, type HistoryItem } from "@/lib/api";
import { scanStatusLabel } from "@/lib/scan-status";
import { TERM, plural } from "@/lib/terms";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "3 hours ago", with the absolute date once relative stops being useful.
 *
 * A raw ISO timestamp is an implementation artefact; a bare relative one is
 * useless for a scan an analyst is correlating with an incident. Returns "" for
 * anything unparseable so a bad value renders nothing rather than "Invalid Date".
 */
function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";

  const diff = ms - Date.now();
  const ago = Math.abs(diff);
  const stamp = new Date(ms).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  // Future timestamps come from clock skew; fall through to the absolute form.
  if (diff < 0 && ago >= DAY) return stamp;
  if (ago < MINUTE) return "just now";
  if (ago < HOUR) {
    const m = Math.round(ago / MINUTE);
    return `${m} ${plural(m, "minute", "minutes")} ago`;
  }
  if (ago < DAY) {
    const h = Math.round(ago / HOUR);
    return `${h} ${plural(h, "hour", "hours")} ago`;
  }
  return stamp;
}

export default function HistoryList({
  onSelect,
  limit = 5,
}: {
  onSelect: (id: string) => void;
  limit?: number;
}) {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchHistory()
      .then((d) => setItems(d.items))
      .catch((e: unknown) =>
        setError(
          e instanceof Error && e.message
            ? e.message
            : "We could not load your saved scans. Try again in a moment.",
        ),
      )
      .finally(() => setLoading(false));
  }, []);

  const shown = items.slice(0, limit);

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle>History</CardTitle>
        <CardDescription>
          Your last {limit} {plural(limit, "scan", "scans")}. Select one to reopen the results it saved.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-24" />
        ) : error ? (
          // Distinct from the empty state on purpose: the API route used to
          // answer a failed request with an empty list, which rendered here as
          // "No scans yet" and told a signed-in analyst their account was empty.
          <Badge variant="destructive">{error}</Badge>
        ) : shown.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-neutral-500">No scans yet — run your first scan above.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {shown.map((h) => {
              const when = formatWhen(h.created_at);
              return (
                <li key={h.scan_id}>
                  <button
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/10"
                    onClick={() => onSelect(h.scan_id)}
                    title={when ? `Scanned ${when}` : "Open this scan"}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono">{h.target}</span>
                      {when && (
                        <span className="block text-xs text-slate-500 dark:text-neutral-500">{when}</span>
                      )}
                    </span>
                    <Badge variant="secondary">{scanStatusLabel(h.status)}</Badge>
                    <span className="w-16">
                      <Progress
                        value={h.risk_score ?? 0}
                        aria-label={`${TERM.risk.label}: ${h.risk_score ?? "not recorded"}`}
                      />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}