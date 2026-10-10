"use client";
import { Badge } from "@/components/ui/badge";
import type { ScanResult } from "@/lib/api";
import { scanStatusView, sourceFailureCount } from "@/lib/scan-status";

export default function ScanStatus({ scan }: { scan: ScanResult | null }) {
  if (!scan) return <p className="text-xs opacity-60">No scan yet — enter a target above.</p>;

  // The raw enum is never rendered: `partial` in particular must not read as a
  // footnote, because that is exactly when a user mistakes an incomplete
  // picture for a clean one. See lib/scan-status.ts.
  const view = scanStatusView(scan.status);
  const failureNote = sourceFailureCount(scan.errors.length);

  return (
    <div className="flex flex-col gap-1 text-sm" aria-label="scan status">
      <div className="flex items-center gap-2">
        <Badge variant={view.tone}>{view.label}</Badge>
        {failureNote && (
          <span className="text-xs text-warning">{failureNote}</span>
        )}
      </div>
      <p className="text-xs opacity-70">{view.detail}</p>
    </div>
  );
}