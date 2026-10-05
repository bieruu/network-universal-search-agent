import type { NvdStatus, ScanResult } from "./api";

// Normalize backend shapes so components never crash on contract drift.
// Backend crtsh = { domain, count, subdomains[] } (never a bare array).
export function getSubdomains(results: ScanResult["results"] | null | undefined) {
  const c = results?.crtsh;
  if (Array.isArray(c)) return c;
  return Array.isArray(c?.subdomains) ? c.subdomains : [];
}

export function getSubdomainCount(results: ScanResult["results"] | null | undefined): number {
  const c = results?.crtsh;
  if (typeof c?.count === "number") return c.count;
  return getSubdomains(results).length;
}

export interface CveEvidence {
  /** Deduplicated CVE ids from Shodan/InternetDB + NVD exact-CPE matches. */
  ids: string[];
  /** Number shown on the card, or null when evidence is missing/unavailable. */
  count: number | null;
  status: NvdStatus | "source_only" | "none";
  hint: string;
}

// Never render missing CVE evidence as "0": unavailable/insufficient data
// shows an em dash plus a hint explaining why the count is unknown.
export function getCveEvidence(results: ScanResult["results"] | null | undefined): CveEvidence {
  const shodanIds = Array.isArray(results?.shodan?.vulns)
    ? results.shodan.vulns.filter((v): v is string => typeof v === "string" && v.startsWith("CVE-"))
    : [];
  const nvd = results?.nvd;
  const rejectedIds = new Set(
    Array.isArray(nvd?.cve_rows)
      ? nvd.cve_rows.filter((r) => r?.tier === "rejected").map((r) => r.id)
      : [],
  );
  const nvdIds = Array.isArray(nvd?.cve_rows)
    ? nvd.cve_rows
        .filter((r) => typeof r?.id === "string" && r.id.startsWith("CVE-") && r.tier !== "rejected")
        .map((r) => r.id)
    : Array.isArray(nvd?.cves)
      ? nvd.cves.filter((c) => typeof c?.id === "string" && c.id.startsWith("CVE-")).map((c) => c.id)
      : [];
  const ids = Array.from(new Set([...shodanIds, ...nvdIds])).filter((id) => !rejectedIds.has(id));
  const status = nvd?.status as NvdStatus | undefined;

  if (!nvd || status === undefined) {
    if (ids.length > 0) {
      return { ids, count: ids.length, status: "source_only", hint: "source IDs only · NVD not checked" };
    }
    return { ids, count: null, status: "none", hint: "no CVE evidence" };
  }
  if (status === "unavailable") {
    return {
      ids,
      count: ids.length > 0 ? ids.length : null,
      status,
      hint: ids.length > 0 ? "partial evidence · NVD unavailable" : "NVD unavailable — not 0",
    };
  }
  if (status === "insufficient_evidence") {
    return {
      ids,
      count: ids.length > 0 ? ids.length : null,
      status,
      hint: ids.length > 0 ? "source IDs only · no CPE to verify" : "no CPE to check — not 0",
    };
  }
  if (status === "no_match") {
    return { ids, count: ids.length, status, hint: "no NVD match for observed CPEs" };
  }
  return { ids, count: ids.length, status: "found", hint: "exact-CPE NVD matches" };
}

