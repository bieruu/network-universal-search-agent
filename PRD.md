# PRD — Network Universal Search Agent (OSINT Dashboard)

**Version:** 1.1.0
**Date:** 2026-10-25
**Status:** v1 implemented (acceptance verified 2026-09/10; claims re-checked against the tree 2026-10-25; history → [CHANGELOG.md](./CHANGELOG.md))
**Stack:** Next.js (App Router) + Tailwind + shadcn/ui + Chart.js + `cobe` (WebGL globe) | FastAPI + PostgreSQL + SQLite + Better Auth

## 1. Vision & Objective

Build an advanced, modern, and secure OSINT Dashboard that aggregates reconnaissance data about a target (domain / IP / hostname) into a single clean interface.

Target user: Security analyst, SOC, bug-bounty hunter, IT admin doing authorized recon.

Core value:
- One search box → aggregated view from Shodan, crt.sh, WHOIS, DNS and NVD.
- Async, non-blocking fetch via FastAPI microservices.
- Dark-mode-first cybersecurity UX with cards, tables, charts.
- Secure by default: server-side secrets, account or bounded guest access, audit trail.

## 2. Personas & Use Cases

| Persona | Goal | Story |
|---|---|---|
| Analyst | Quick triage of a domain | "As analyst, I input `example.com` and see open ports, subdomains, WHOIS, risk in <10s" |
| Admin | Control access & cost | "As admin, scans are rate-limited per account plus a bounded guest allowance, and Shodan usage is capped and logged" |
| Auditor | Review history | "As auditor, I reopen any of my past scans and see the stored snapshot, target and risk score exactly as they were recorded" |

## 3. Technology Stack (Locked)

### Frontend
- Next.js 15+ (App Router, TypeScript strict)
- Tailwind CSS + shadcn/ui (Radix primitives) — responsive, accessible
- Chart.js via `react-chartjs-2` for the dashboard's two charts (ports bar, risk-trend line). Since the **2026-10-14 operator-approved reversal** 3D/WebGL is allowed too, via `three` + `@react-three/fiber` + `@react-three/drei` (AGENTS.md §6), on condition the same data stays available as text/table; the landing hero globe is rendered with `cobe`. *(2026-10-25: the three 3D packages are declared in `frontend/package.json` and pinned by `lib/react-stack.test.ts`, but no source file imports them today; the earlier claim "no custom canvas lib" is therefore no longer accurate — `cobe` is one.)*
- Better Auth client for session, `fetch` to FastAPI via Next Route Handler proxy (to hide internal URLs)

### Backend & Services
- Python 3.11+ + FastAPI (async, Pydantic v2)
- PostgreSQL (primary) via SQLAlchemy 2.0 async + Alembic. Prisma/Drizzle only if Node BFF is added later — default is SQLAlchemy.
- SQLite (optional local cache): raw JSON responses + quick logs, TTL 24h, never as source of truth. `CACHE_BACKEND=postgres` swaps it for an `osint_cache` table on hosts without a persistent volume.
- Better Auth (server) for auth; FastAPI verifies session/JWT per request

### OSINT Integrations (FastAPI services)

Integrated, in the scan path (`backend/app/services/`):

1. **Shodan API** (`shodan_service.py`): host info — ports, services, banners, vulns, ISP/ASN/geo. Requires `SHODAN_API_KEY`; falls back to Shodan's keyless InternetDB on HTTP 403/404.
2. **crt.sh API** (`crtsh_service.py`): `https://crt.sh/?q=%25.{domain}&output=json` — subdomains, certs, issuer, validity. No key, needs dedup + timeout handling. On failure the orchestrator walks **Cert Spotter** (`certspotter_service.py`) then an optional **Subfinder** CLI (`subfinder_service.py`).
3. **WHOIS** (`whois_service.py`): python-whois in `asyncio.to_thread` — registrar, creation/expiry, name servers, registrant email (if public).
4. **DNS** (`dns_service.py`): A, AAAA, MX, NS, TXT, CNAME, SOA via `dns.asyncresolver`, per-type isolation, skipped for an IP literal.
5. **NVD CVE enrichment** (`nvd_service.py`): exact-CPE lookup plus CVE-ID cross-check and a capped keyword fallback; after Shodan succeeds.

Optional threat-history sources, only when the CVE list came back empty (`orchestrator._threat_history_fallback`): **AlienVault OTX** (`otx_service.py`, works keyless), **URLScan.io search** (`urlscan_service.py`), **Leak-Lookup** (`leaklookup_service.py`, key required). Each reports `not_configured` when its key is absent.

Analysis-only capabilities (`/api/v1/analysis/*`, not part of a scan): TLS certificate detail (`tls_service.py`), response headers and cookies (`http_headers_service.py`), redirect chain (`redirect_service.py`), sitemap (`sitemap_service.py`), contact extraction (`contact_service.py`), EXIF (`exif_service.py`), phone validation (`phone_lookup_service.py`). **VirusTotal is deliberately not integrated** (licensing, see ARCHITECTURE.md §4.3); `VIRUSTOTAL_API_KEY` only flips the `/capabilities` flag today.

## 4. Functional Requirements

### FR-1 Unified Search
- FR-1.1 Input accepts domain (`example.com`), subdomain, IPv4. Validate with Zod (FE) + Pydantic (BE). Reject private IPs / localhost by default.
- FR-1.2 `POST /api/v1/scan` starts orchestrated scan: `{ target, force? }` → `{ scan_id, status }`.
- FR-1.3 `GET /api/v1/scan/{id}` polls status (`pending|running|completed|partial|failed`) + aggregated result.
- FR-1.4 UI shows skeleton/loading per-card (New scan card, stats strip, ports, CVEs, subdomains, WHOIS, history) — partial render allowed.

### FR-2 Dashboard Display
- FR-2.1 Header: the shell's sticky header names the scanned target (`Scan <target>`, else `Welcome back`) plus the live session indicator. The **Re-scan** button lives in the New scan card beside the input, not in the header; the current scan's risk score is shown as the per-target trend line and per row in History. *(Corrected 2026-10-25: the earlier requirement — target, target_type, risk score, scan time and re-scan all in the header — does not match `app-shell.tsx` or `dashboard/page.tsx`.)*
- FR-2.2 Stats: one instrument strip of four cells — open ports, services, CVEs (only verified/unverified evidence, with an "incomplete" hint when NVD coverage is missing) and subdomains. *(Corrected 2026-10-25: the four gradient cards and the `Domain age` figure are gone; `statsFromScan` emits exactly these four keys.)*
- FR-2.3 Tables and cards: ports (`Port` / `Product` / `Version` / banner), subdomains (name, validity badge, filter all/active/expired/unknown, paged), CVE evidence (`VulnerabilitiesCard`: CVE, tier, severity, CVSS, evidence CPE, source), threat history (`ThreatHistoryCard`, only when the CVE list is empty), WHOIS card, history list (last 5, select to reopen) and Latest findings. *(Corrected 2026-10-25: the old "Vulns (CVE, CVSS, ports affected)" table and the "first-seen" subdomain column were never shipped in that shape.)*
- FR-2.4 Charts (Chart.js, dynamically imported with `ssr:false`): ports distribution grouped by detected product (bar) and risk trend per target (line, up to 10 scans). *(Corrected 2026-10-25: there is no doughnut and no subdomain certificate timeline.)*
- FR-2.5 Dark-mode optimized default, light toggle. Must pass contrast AA.

### FR-3 Async Processing
- FR-3.1 FastAPI uses `asyncio.gather(..., return_exceptions=True)` with per-source timeout (Shodan 12s, crt.sh 30s code default / 15s in the shipped `.env`, WHOIS 10s, DNS 10s, NVD 12s) — all overridable via `SCAN_TIMEOUT_*`.
- FR-3.2 UI never blocks >300ms on click; all long work is poll/WebSocket.
- FR-3.3 Partial failure → `status=partial` + per-source `errors[]`, UI shows warning badge, not full crash.

### FR-4 Secure Access
- FR-4.1 Authorization is enforced by the backend, not by page middleware. `frontend/middleware.ts` is **CSP + nonce only since 2026-10-14** and does no auth work: `/dashboard` and the landing page render for anyone, and every API route answers 401 for a subject it does not admit. `POST /api/v1/scan` and `GET /api/v1/scan/{id}` call `require_user_or_guest()`, which admits a signed-out visitor as `guest:<id>` via an HMAC-signed `X-Guest-Token` minted by the Next proxy, bounded by `GUEST_SCAN_LIMIT_PER_DAY` (default 2 per guest per rolling 24h) and `GUEST_SCAN_DAILY_TOTAL` (default 20 instance-wide, the bound a cleared cookie cannot reset); `0` for the per-guest limit closes admission with 401. History, trend (`/target/{t}/trend`), analysis (`/api/v1/analysis/*`) and `/health/sources` keep `require_user()`. A guest therefore scans but owns no history. *(Corrected 2026-10-25: the earlier claim — every `/dashboard`, `/target/*` and `/api/scan/*` behind Better Auth middleware with a `/sign-in` redirect — was true before the 2026-10-14 reversal and is no longer. Direct FastAPI call with neither a session nor a guest token → 401.)*
- FR-4.2 API keys only in FastAPI env, never exposed to client. Frontend calls Next proxy → FastAPI.
- FR-4.3 Rate limit: `RATE_LIMIT_PER_HOUR` scans/account/hour (default 5; production refuses to boot above `PRODUCTION_RATE_LIMIT_CEILING` or without it set), optional instance-wide `RATE_LIMIT_DAILY_TOTAL`, `RATE_LIMIT_MAX_KEYS` ceiling, and a separate `FREE_RATE_LIMIT_PER_HOUR` for the analysis capabilities that cost no Shodan credit. 429 with `Retry-After`.
- FR-4.4 Audit: every scan is persisted as an immutable `scans` row (`user_id`, `target_id`, `status`, `risk_score`, `errors[]`, `created_at`/`completed_at`) — that row is the audit record. The JSON request log (`app/core/logging.py`) adds `request_id`, path, method and `latency_ms`. *(Corrected 2026-10-25: the log does not carry `user_id`, `target` or `sources_ok`; those live on the scan row, which references the target by `target_id` — there is no `target` column.)*

### FR-5 Persistence
- FR-5.1 PostgreSQL tables: `users (via Better Auth), targets, scans, findings` — see ARCHITECTURE.md §5.
- FR-5.2 History: a card on the dashboard listing the account's last 5 scans, newest first, click to re-open the immutable snapshot. The API behind it (`GET /api/v1/history`) accepts `target`, `page` and `limit`, so more than 5 is paginated server-side; there is no separate `/history` page. *(Corrected 2026-10-25.)*
- FR-5.3 TTL cache: key `source:target`, TTL 24h, stores raw JSON to reduce Shodan quota. Same shapes as `sqlite` or `postgres`, per `CACHE_BACKEND`.
- FR-5.4 Re-scan forces bypass cache (`force=true`).

## 5. Non-Functional Requirements

| ID | Requirement | Target |
|---|---|---|
| NFR-1 | p95 scan (cache miss) | <12s |
| NFR-2 | p95 scan (cache hit) | <1.5s |
| NFR-3 | Availability | Best-effort, degrade to partial if 1 source down |
| NFR-4 | Security | OWASP ASVS L1: no secrets in client, validated input, parametrized ORM, CORS allowlist |
| NFR-5 | Accessibility | shadcn/Radix keyboard nav, aria-labels, AA contrast |
| NFR-6 | Observability | structlog JSON + `X-Request-ID`, `/health`, `/ready` |

## 6. Risk Score (v1 heuristic, transparent)

```
score = min(100, 15*open_ports_factor + 25*vuln_factor + 10*tls_factor + 10*subdomain_factor)
- open_ports_factor: >5 ports=1.0, 3-5=0.6, 1-2=0.3
- vuln_factor: any critical CVE (or CVSS >= 9)=1.0; else any high CVE or >= 3 evidence IDs=0.7;
  any evidence at all=0.4; none=0. Keyword-derived CVE rows never score.
- tls_factor: an expired certificate in the crt.sh set=1.0, one expiring within 30 days=0.7, otherwise 0.2
  (with no crt.sh names at all the factor is 0.0 — nothing to weigh, not a penalty)
- subdomain_factor: >20 names=1.0, 6-20=0.5, 5 or fewer=0
- The breakdown travels as `results._risk_breakdown` (`backend/app/services/risk.py`);
  `vulns_incomplete`, `rejected_cves` and `keyword_leads` say when coverage was missing.
```

*(2026-10-25: the breakdown is in the payload but the UI renders no tooltip and no "Heuristic v1 — not a pentest verdict" label — that requirement is unshipped, not verified.)*

Trend: store `risk_score` per scan, chart last 10 scans per target.

## 7. Out of Scope (v1)

- Active scanning (nmap nuclei intrusive), port-scanning directly — passive OSINT only. DNS is the one lookup the backend performs itself, against the target's own nameservers (no packet reaches the target host); see ARCHITECTURE.md §4.3.
- Multi-user orgs/RBAC beyond `user/admin`.
- Webhooks, scheduled monitoring (→ v2).
- Mobile native app.

*(Corrected 2026-10-25: "PDF export" was listed here and has shipped — JSON, Markdown and PDF are built in the browser by `frontend/lib/export-findings.ts`, `lib/export-pdf.ts` and the dashboard's `ExportFindingsCard`. The original entry is removed rather than annotated because nothing about it remains true.)*

## 8. Acceptance Criteria (verified 2026-09-28; evidence in TODO.md Phase 4)

- [x] ~~Login required to access `/dashboard`; direct URL without session redirects (live 307).~~ *(superseded 2026-10-14: the dashboard now renders in guest mode with a quota banner and locked history/trend cards. Authorization moved to the backend — see FR-4.1. The 307 was real on 2026-09-28 and is kept as the record.)*
- [x] Scan `example.com` returns Shodan + crt.sh + WHOIS cards in <12s or partial with error badge (live: completed, 12 ports / 10 subs / WHOIS, risk 20, miss 5.2s server-side). *(2026-09-28 record; the scan now also runs DNS and NVD enrichment, see FR-3.1.)*
- [x] Charts render with real data, empty state if no data (no crash) — empty states tested (`components.test.ts`).
- [ ] History persists after restart (Postgres), re-open shows identical snapshot (needs Docker Postgres — not available in this env; sqlite history + trend verified live: 3 items / 3 points). *(2026-10-25: Docker **is** available in this environment now, and on a throwaway `postgres:16` container `alembic upgrade head` created `targets`/`scans`/`findings` and `alembic check` reported "No new upgrade operations detected". The end-to-end restart-and-reopen check was not run in this pass, so the box stays unticked.)*
- [x] No API key visible in browser network tab / bundle (grep `.next/static` clean). *(2026-10-25 re-check: a grep of the build present in the tree finds no key name or value from the backend env block, with one exception worth naming — Better Auth's own bundled `getEnvVar(key)` helper in the dashboard chunk contains the literal string `"BETTER_AUTH_SECRET"` and reads `process.env[key]` at runtime, so the variable name ships but never its value.)*
- [ ] `docker compose up` + documented `.env` yields working app locally (docker missing in this env; compose file + Dockerfile present, untested). *(2026-10-25: Docker is installed here (29.8.1) and the compose file's Postgres service starts; the full app path — Better Auth tables, frontend, a live scan — was not exercised in this pass. Unticked, unverified.)*

## 9. Environment Variables

Single source of truth: [backend/.env.example](./backend/.env.example) and [frontend/.env.local.example](./frontend/.env.local.example), documented in [WORKFLOW.md §3](./WORKFLOW.md#3-environment-reference). Do not duplicate env values in this document.

## 10. Milestones

- M1 Scaffold + Auth + DB (week 1)
- M2 3 integrations + orchestrator (week 2)
- M3 Dashboard UI + charts + history (week 3)
- M4 Hardening + tests + docs (week 4)

Related: ARCHITECTURE.md, TODO.md, WORKFLOW.md, AGENTS.md.
