"use client";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchHistory, type HistoryItem } from "@/lib/api";

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
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load history"))
      .finally(() => setLoading(false));
  }, []);

  const shown = items.slice(0, limit);

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle>History</CardTitle>
        <CardDescription>Latest {limit} scans, click to reopen snapshot</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-24" />
        ) : error ? (
          <Badge variant="destructive">{error}</Badge>
        ) : shown.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-neutral-500">No scans yet — run your first scan above.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {shown.map((h) => (
              <li key={h.scan_id}>
                <button
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/10"
                  onClick={() => onSelect(h.scan_id)}
                >
                  <span className="min-w-0 flex-1 truncate font-mono">{h.target}</span>
                  <Badge variant="secondary">{h.status}</Badge>
                  <span className="w-16">
                    <Progress value={h.risk_score ?? 0} aria-label={`risk ${h.risk_score ?? "unknown"}`} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
