export type ScanStatus = "pending" | "running" | "completed" | "partial" | "failed";

export interface SourceError {
  source: string;
  message: string;
}

export type NvdStatus = "found" | "no_match" | "insufficient_evidence" | "unavailable";

export interface NvdCve {
  id: string;
  description?: string;
  cvss?: number | null;
  severity?: string | null;
  published?: string;
  references?: string[];
  evidence_cpe?: string;
  vuln_status?: string | null;
}

export type CveTier = "verified" | "unverified" | "rejected";

export interface NvdCveRow {
  id: string;
  tier?: CveTier | string;
  source?: string;
  severity?: string | null;
  cvss?: number | null;
  evidence_cpe?: string | null;
  vuln_status?: string | null;
  description?: string | null;
  url?: string;
}

export interface ScanResult {
  scan_id: string;
  target: string;
  status: ScanStatus;
  risk_score: number | null;
  results: {
    shodan?: {
      source?: string;
      ip?: string;
      ports?: number[];
      services?: Array<{ port: number; product?: string; version?: string; banner?: string; cpes?: string[] }>;
      vulns?: string[];
      cpes?: string[];
      isp?: string;
      asn?: string;
      city?: string;
      country?: string;
    };
    nvd?: {
      source?: string;
      status?: NvdStatus;
      checked_cpes?: string[];
      cves?: NvdCve[];
      cve_rows?: NvdCveRow[];
      truncated?: boolean;
      errors?: string[];
      note?: string;
    };
    crtsh?: {
      domain?: string;
      source?: string;
      count?: number;
      subdomains?: Array<{ subdomain: string; issuer?: string; not_before?: string; not_after?: string }>;
    };
    whois?: {
      registrar?: string;
      creation_date?: string;
      expiration_date?: string;
      name_servers?: string[];
      emails?: string | null;
    };
  };
  errors: SourceError[];
}

export interface HistoryItem {
  scan_id: string;
  target: string;
  status: ScanStatus;
  risk_score: number | null;
  created_at: string;
}

async function handle<T>(res: Response): Promise<T> {
  if (res.status === 401) throw new Error("Unauthorized — please sign in again.");
  if (res.status === 429) throw new Error("Rate limited — try again later.");
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return (await res.json()) as T;
}

export async function startScan(target: string, force = false): Promise<{ scan_id: string; status: ScanStatus }> {
  const res = await fetch("/api/scan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target, force }),
  });
  return handle(res);
}

export async function fetchScan(id: string): Promise<ScanResult> {
  const res = await fetch(`/api/scan/${id}`, { cache: "no-store" });
  return handle(res);
}

const TERMINAL: ScanStatus[] = ["completed", "partial", "failed"];

// Poll GET /api/scan/{id} every intervalMs until terminal state or timeout.
export async function pollScan(
  id: string,
  opts: { intervalMs?: number; timeoutMs?: number; onUpdate?: (s: ScanResult) => void } = {},
): Promise<ScanResult> {
  const intervalMs = opts.intervalMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 60000;
  const start = Date.now();
  for (;;) {
    const s = await fetchScan(id);
    opts.onUpdate?.(s);
    if (TERMINAL.includes(s.status)) return s;
    if (Date.now() - start > timeoutMs) return s;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export async function fetchHistory(target?: string): Promise<{ items: HistoryItem[]; total: number }> {
  const q = target ? `?target=${encodeURIComponent(target)}` : "";
  const res = await fetch(`/api/history${q}`, { cache: "no-store" });
  return handle(res);
}

export async function fetchTrend(target: string): Promise<{ points: Array<{ scan_id: string; created_at: string; risk_score: number | null }> }> {
  const res = await fetch(`/api/trend/${encodeURIComponent(target)}`, { cache: "no-store" });
  return handle(res);
}
