/**
 * User-facing labels for the scan state machine.
 *
 * The raw enums (`pending`, `running`, `partial`, `insufficient_evidence`) used
 * to render straight into badges in five different places. Two problems with
 * that, both serious enough to warrant a dedicated map:
 *
 *  1. `partial` reads as a minor footnote. It actually means "some sources
 *     failed and you are looking at an incomplete picture" — the exact moment
 *     where a user is most likely to read absence-of-findings as safety. It
 *     must not render as a single neutral word.
 *  2. The NVD enum is snake_case (`insufficient_evidence`). An underscore in
 *     user-facing chrome is an implementation tell, not a style choice.
 */

import type { NvdStatus, ScanStatus } from "./api.ts";
import { plural } from "./terms.ts";

export interface StatusView {
  /** Badge text. Complete on its own — never a bare identifier. */
  label: string;
  /** One line saying what this state means for the user's data. */
  detail: string;
  /** Badge variant. `destructive` only for outright failure. */
  tone: "default" | "secondary" | "outline" | "destructive";
}

const SCAN_STATUS: Record<ScanStatus, StatusView> = {
  pending: {
    label: "Queued",
    detail: "Your search is in the queue and will start shortly.",
    tone: "secondary",
  },
  running: {
    label: "Searching",
    detail: "Reading public sources about this target now.",
    tone: "default",
  },
  completed: {
    label: "Complete",
    detail: "Every source answered.",
    tone: "secondary",
  },
  partial: {
    label: "Partly answered",
    detail: "At least one source failed, so this result is incomplete. Missing items were not checked — treat them as unknown, not as absent.",
    tone: "default",
  },
  failed: {
    label: "Failed",
    detail: "No source returned a result for this target.",
    tone: "destructive",
  },
};

export function scanStatusView(status: ScanStatus | string | null | undefined): StatusView {
  if (typeof status === "string" && status in SCAN_STATUS) {
    return SCAN_STATUS[status as ScanStatus];
  }
  return {
    label: "Unknown",
    detail: "This search returned a status this dashboard does not recognise. Treat the result as unknown, not as clean.",
    tone: "outline",
  };
}

/** Short badge text only — for dense rows like the history list. */
export function scanStatusLabel(status: ScanStatus | string | null | undefined): string {
  return scanStatusView(status).label;
}

const NVD_STATUS: Record<NvdStatus, StatusView> = {
  found: {
    label: "Checked against known vulnerabilities",
    detail: "We identified the running software and found catalogue entries that match this exact product and version.",
    tone: "default",
  },
  no_match: {
    label: "Checked — no matching entries",
    detail: "We identified the running software and found no catalogue entry for that exact product and version. That is not proof the host is safe.",
    tone: "secondary",
  },
  insufficient_evidence: {
    label: "Could not check",
    detail: "The running software did not advertise an exact product and version, so there was nothing precise to check. Coverage is unknown, not zero.",
    tone: "outline",
  },
  unavailable: {
    label: "Database unreachable",
    detail: "The vulnerability database did not respond, so what you see is incomplete rather than empty.",
    tone: "destructive",
  },
  keyword_derived: {
    label: "Keyword leads only",
    detail: "No exact match was found, so we listed entries whose description happens to mention a detected product name. Investigate these — do not treat them as confirmed.",
    tone: "outline",
  },
};

export function nvdStatusView(status: NvdStatus | string | null | undefined): StatusView {
  if (typeof status === "string" && status in NVD_STATUS) {
    return NVD_STATUS[status as NvdStatus];
  }
  return {
    label: "Not checked",
    detail: "No check ran for this target.",
    tone: "outline",
  };
}

/** How confident we are that a listed CVE applies to this host. */
export const CVE_TIER: Record<string, StatusView> = {
  verified: {
    label: "Confirmed match",
    detail: "Matches the exact product and version running on this host.",
    tone: "default",
  },
  unverified: {
    label: "Reported, unconfirmed",
    detail: "A public index reported this vulnerability for this host, but we could not confirm it against the exact product and version.",
    tone: "outline",
  },
  rejected: {
    label: "Rejected by the publisher",
    detail: "The catalogue vendor marked this entry as rejected or disputed. Shown for completeness — never counted.",
    tone: "secondary",
  },
};

export function cveTierView(tier: string | null | undefined): StatusView {
  return (
    (typeof tier === "string" && CVE_TIER[tier]) || {
      label: "Unverified",
      detail: "No evidence tier was recorded for this entry.",
      tone: "outline" as const,
    }
  );
}

/**
 * Describes a failed source without exposing the provider's internal name or
 * exception text. The raw `{source, message}` pair from the backend reaches
 * the dashboard verbatim and is what produced badges reading `shodan: timeout`.
 */
export function sourceFailureCount(n: number): string {
  if (n <= 0) return "";
  return `${n} ${plural(n, "source", "sources")} did not answer. Results below are incomplete.`;
}