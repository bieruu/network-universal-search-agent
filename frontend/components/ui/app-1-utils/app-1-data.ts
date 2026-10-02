import type { ScanResult } from "@/lib/api";
import { getSubdomainCount } from "@/lib/scan-shape";

export interface StatItem {
  key: string;
  label: string;
  value: string;
  hint: string;
}

export const NAV_ITEMS = [
  { label: "Dashboard", href: "/dashboard" },
  { label: "Sign in", href: "/sign-in" },
] as const;

export const SOURCE_MONOGRAMS = [
  { label: "Shodan", short: "SH" },
  { label: "crt.sh", short: "CT" },
  { label: "WHOIS", short: "WO" },
] as const;

export function statsFromScan(scan: ScanResult | null): StatItem[] {
  if (!scan) {
    return [
      { key: "ports", label: "Open ports", value: "—", hint: "no active scan" },
      { key: "services", label: "Services", value: "—", hint: "no active scan" },
      { key: "vulns", label: "Vulns", value: "—", hint: "no active scan" },
      { key: "subs", label: "Subdomains", value: "—", hint: "no active scan" },
    ];
  }
  const hint = `${scan.target} · ${scan.status}`;
  return [
    { key: "ports", label: "Open ports", value: String(scan.results.shodan?.ports?.length ?? 0), hint },
    { key: "services", label: "Services", value: String(scan.results.shodan?.services?.length ?? 0), hint },
    { key: "vulns", label: "Vulns", value: String(scan.results.shodan?.vulns?.length ?? 0), hint },
    { key: "subs", label: "Subdomains", value: String(getSubdomainCount(scan.results)), hint },
  ];
}

export function latestFindings(scan: ScanResult | null): string[] {
  if (!scan) return [];
  const out: string[] = [];
  for (const p of scan.results.shodan?.ports?.slice(0, 3) ?? []) out.push(`port ${p} open`);
  for (const v of scan.results.shodan?.vulns?.slice(0, 2) ?? []) out.push(v);
  for (const s of scan.results.crtsh?.subdomains?.slice(0, 3) ?? []) out.push(s.subdomain);
  return out.slice(0, 6);
}
