import type { ScanResult } from "./api";

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
