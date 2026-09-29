"use client";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchHistory, type HistoryItem } from "@/lib/api";

export default function HistoryList({ onSelect }: { onSelect: (id: string) => void }) {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchHistory()
      .then((d) => setItems(d.items))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load history"))
      .finally(() => setLoading(false));
  }, []);

  return (
    <Card>
      <CardTitle>History</CardTitle>
      {loading ? (
        <Skeleton className="mt-2 h-16" />
      ) : error ? (
        <Badge variant="destructive">{error}</Badge>
      ) : items.length === 0 ? (
        <p className="mt-2 text-sm opacity-60">No scans yet.</p>
      ) : (
        <ul className="mt-2 space-y-1 text-sm">
          {items.slice(0, 20).map((h) => (
            <li key={h.scan_id}>
              <button className="underline opacity-80 hover:opacity-100" onClick={() => onSelect(h.scan_id)}>
                {h.target}
              </button>{" "}
              <span className="opacity-60">
                {h.status} · {h.risk_score ?? "—"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
