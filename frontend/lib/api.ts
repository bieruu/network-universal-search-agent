export type ScanStatus = "pending" | "running" | "completed" | "partial" | "failed";

export interface SourceError {
  source: string;
  message: string;
}

// `keyword_derived` is the NVD keywordSearch FALLBACK, which runs only when the
// exact-CPE path produced nothing. Its rows are leads — a CVE whose description
// mentions a detected product term — so they are never `verified` and never
// counted toward the risk score (the backend enforces both).
export type NvdStatus =
  | "found"
  | "no_match"
  | "insufficient_evidence"
  | "unavailable"
  | "keyword_derived";

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
  // True when the row came from the NVD keywordSearch fallback rather than an
  // exact-CPE match. Such a row is a LEAD — the CVE's description mentions a
  // detected product term, which says nothing about this host. The backend
  // never scores these and never marks them `verified`.
  keyword_derived?: boolean;
  keyword?: string;
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
    // Passive host enrichment derived from the Shodan payload (no extra paid
    // key). Absent when Shodan itself failed.
    host?: {
      source?: string;
      ip?: string | null;
      asn?: string | null;
      asn_org?: string | null;
      isp?: string | null;
      org?: string | null;
      city?: string | null;
      region?: string | null;
      country?: string | null;
      country_code?: string | null;
      postal_code?: string | null;
      latitude?: number | null;
      longitude?: number | null;
      timezone?: string | null;
      network?: string | null;
      domain?: string | null;
      os?: string | null;
      hostnames?: string[];
      open_ports?: Array<{ port: number; transport?: string; product?: string | null; version?: string | null; banner?: string | null }>;
      port_count?: number;
      ports_truncated?: boolean;
      note?: string;
    };
    // Breach/defacement history. Present ONLY when official CVE data came back
    // empty, which is why the card renders nothing when it is absent. Typed as
    // unknown because the shape is validated at the point of use
    // (lib/threat-history-shape.ts) — it is third-party data and must not be
    // trusted to match a compile-time shape at the call site.
    history?: unknown;
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
