import type { ScanResult } from "@/lib/api";
import { getSubdomainCount } from "@/lib/scan-shape";
import { getCveEvidence } from "@/lib/scan-shape";
import { scanStatusLabel } from "@/lib/scan-status";
import { TERM } from "@/lib/terms";

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
  { label: "Shodan", short: "SH", provenance: "Public index of internet-wide scans" },
  { label: "crt.sh", short: "CT", provenance: "Public log of every TLS certificate issued" },
  { label: "WHOIS", short: "WO", provenance: "The public domain registration record" },
] as const;

export function statsFromScan(scan: ScanResult | null): StatItem[] {
  if (!scan) {
    return [
      { key: "ports", label: TERM.ports.label, value: "—", hint: "no scan yet" },
      { key: "services", label: TERM.services.label, value: "—", hint: "no scan yet" },
      { key: "vulns", label: TERM.cves.label, value: "—", hint: "no scan yet" },
      { key: "subs", label: TERM.subdomains.label, value: "—", hint: "no scan yet" },
    ];
  }
  const hint = `${scan.target} · ${scanStatusLabel(scan.status)}`;
  const evidence = getCveEvidence(scan.results);
  return [
    { key: "ports", label: TERM.ports.label, value: String(scan.results.shodan?.ports?.length ?? 0), hint },
    { key: "services", label: TERM.services.label, value: String(scan.results.shodan?.services?.length ?? 0), hint },
    {
      key: "vulns",
      label: TERM.cves.label,
      value: evidence.count == null ? "—" : String(evidence.count),
      hint: evidence.hint,
    },
    { key: "subs", label: TERM.subdomains.label, value: String(getSubdomainCount(scan.results)), hint },
  ];
}

export function latestFindings(scan: ScanResult | null): string[] {
  if (!scan) return [];
  const out: string[] = [];
  for (const p of scan.results.shodan?.ports?.slice(0, 3) ?? []) out.push(`Port ${p} open`);
  for (const v of getCveEvidence(scan.results).ids.slice(0, 2) ?? []) out.push(v);
  for (const s of scan.results.crtsh?.subdomains?.slice(0, 3) ?? []) out.push(s.subdomain);
  return out.slice(0, 6);
}
