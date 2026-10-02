"use client";
import { Badge } from "@/components/ui/badge";
import type { ScanResult } from "@/lib/api";

export default function ScanStatus({ scan }: { scan: ScanResult | null }) {
  if (!scan) return <p className="text-xs opacity-60">No scan yet — enter a target above.</p>;
  const variant = scan.status === "failed" ? "destructive" : "default";
  return (
    <div className="flex items-center gap-2 text-sm" aria-label="scan status">
      <Badge variant={variant}>{scan.status}</Badge>
      <span className="text-xs opacity-70">scan_id: {scan.scan_id}</span>
      {scan.errors.length > 0 && (
        <span className="text-xs text-warning">
          {scan.errors.length} source error(s)
        </span>
      )}
    </div>
  );
}
