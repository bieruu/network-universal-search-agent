"use client";
import { Badge } from "@/components/ui/badge";
import type { ScanResult } from "@/lib/api";
import { scanStatusView, sourceFailureCount } from "@/lib/scan-status";

export default function ScanStatus({
  scan,
  polling = false,
}: {
  scan: ScanResult | null;
  /** True only while this scan is being polled right now. */
  polling?: boolean;
}) {
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
        {/* The blip reports state, so it only runs while there is a state to
            report: it is tied to `polling`, not to the badge existing. A
            status dot that keeps blinking after the scan has finished is a
            dashboard claiming to be busy when it is not — the same lie as a
            spinner that never stops. Opacity only, `motion-safe:` gated, and
            hidden from assistive tech because the badge text already says it. */}
        {polling && (
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 rounded-full bg-accent motion-safe:animate-blip"
          />
        )}
        {failureNote && (
          <span className="text-xs text-warning">{failureNote}</span>
        )}
      </div>
      <p className="text-xs opacity-70">{view.detail}</p>
    </div>
  );
}
