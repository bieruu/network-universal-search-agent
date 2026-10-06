# PRD — Network Universal Search Agent (OSINT Dashboard)

**Version:** 1.0.0
**Date:** 2026-09-27
**Status:** v1 implemented (acceptance verified 2026-09/10; history → [CHANGELOG.md](./CHANGELOG.md))
**Stack:** Next.js (App Router) + Tailwind + shadcn/ui + Chart.js | FastAPI + PostgreSQL + SQLite + Better Auth

## 1. Vision & Objective

Build an advanced, modern, and secure OSINT Dashboard that aggregates reconnaissance data about a target (domain / IP / hostname) into a single clean interface.

Target user: Security analyst, SOC, bug-bounty hunter, IT admin doing authorized recon.

Core value:
- One search box → aggregated view from Shodan, crt.sh, WHOIS.
- Async, non-blocking fetch via FastAPI microservices.
- Dark-mode-first cybersecurity UX with cards, tables, charts.
- Secure by default: auth-gated queries, server-side secrets, audit trail.

## 2. Personas & Use Cases

| Persona | Goal | Story |
|---|---|---|
| Analyst | Quick triage of a domain | "As analyst, I input `example.com` and see open ports, subdomains, WHOIS, risk in <10s" |
| Admin | Control access & cost | "As admin, only logged-in users can scan, Shodan usage is rate-limited and logged" |
| Auditor | Review history | "As auditor, I can see who scanned what and when, and re-open past results" |

## 3. Technology Stack (Locked)

### Frontend
- Next.js 15+ (App Router, TypeScript strict)
- Tailwind CSS + shadcn/ui (Radix primitives) — responsive, accessible
- Chart.js via `react-chartjs-2` — trends only, no custom canvas lib
- Better Auth client for session, `fetch` to FastAPI via Next Route Handler proxy (to hide internal URLs)

### Backend & Services
- Python 3.11+ + FastAPI (async, Pydantic v2)
- PostgreSQL (primary) via SQLAlchemy 2.0 async + Alembic. Prisma/Drizzle only if Node BFF is added later — default is SQLAlchemy.
- SQLite (optional local cache): raw JSON responses + quick logs, TTL 24h, never as source of truth
- Better Auth (server) for auth; FastAPI verifies session/JWT per request

### OSINT Integrations (FastAPI services)
1. **Shodan API** (`services/shodan_service.py`): host info — ports, services, banners, vulns, ISP/ASN/geo. Requires `SHODAN_API_KEY`.
2. **crt.sh API** (`services/crtsh_service.py`): `https://crt.sh/?q=%25.{domain}&output=json` — subdomains, certs, issuer, validity. No key, needs dedup + timeout handling.
3. **WHOIS** (`services/whois_service.py`): python-whois — registrar, creation/expiry, name servers, registrant email (if public).

## 4. Functional Requirements

### FR-1 Unified Search
- FR-1.1 Input accepts domain (`example.com`), subdomain, IPv4. Validate with Zod (FE) + Pydantic (BE). Reject private IPs / localhost by default.
- FR-1.2 `POST /api/v1/scan` starts orchestrated scan: `{ target, target_type }` → `{ scan_id, status }`.
- FR-1.3 `GET /api/v1/scan/{id}` polls status (`pending|running|completed|partial|failed`) + aggregated result.
- FR-1.4 UI shows skeleton/loading per-card (Shodan card, Subdomains card, WHOIS card) — partial render allowed.

### FR-2 Dashboard Display
- FR-2.1 Header: target, target_type, risk score (0-100), scan time, re-scan button.
- FR-2.2 Cards: Open Ports summary, Services count, Vulns count, Subdomains count, Domain age.
- FR-2.3 Tables: Open ports (port/proto/service/banner), Subdomains (subdomain, cert issuer, first-seen), Vulns (CVE, CVSS, ports affected).
- FR-2.4 Charts (Chart.js): ports distribution (doughnut), top services (bar), subdomain cert timeline (line), risk trend per target (line, from history).
- FR-2.5 Dark-mode optimized default, light toggle. Must pass contrast AA.

### FR-3 Async Processing
- FR-3.1 FastAPI uses `asyncio.gather(..., return_exceptions=True)` with per-source timeout (Shodan 12s, crt.sh 15s, WHOIS 10s).
- FR-3.2 UI never blocks >300ms on click; all long work is poll/WebSocket.
- FR-3.3 Partial failure → `status=partial` + per-source `errors[]`, UI shows warning badge, not full crash.

### FR-4 Secure Access
- FR-4.1 All `/dashboard`, `/target/*`, `/api/scan/*` behind Better Auth middleware. Unauthed → `/sign-in`.
- FR-4.2 API keys only in FastAPI env, never exposed to client. Frontend calls Next proxy → FastAPI.
- FR-4.3 Rate limit: 10 scans/user/hour, 30/day (configurable). 429 with `Retry-After`.
- FR-4.4 Audit: every scan logs `user_id, target, timestamp, sources_ok, latency`.

### FR-5 Persistence
- FR-5.1 PostgreSQL tables: `users (via Better Auth), targets, scans, findings` — see ARCHITECTURE.md §5.
- FR-5.2 History page: paginated scans per user, filter by target, click to re-open snapshot (immutable JSONB).
- FR-5.3 SQLite cache: key `source:target`, TTL 24h, stores raw JSON to reduce Shodan quota.
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
score = min(100, 15*open_ports_factor + 25*vuln_factor + 10*old_tls_or_expired + 10*subdomain_exposure)
- open_ports_factor: >5 ports=1.0, 3-5=0.6, 1-2=0.3
- vuln_factor: any critical CVE=1.0, high=0.7, medium=0.4, else 0
- Show breakdown tooltip, label "Heuristic v1 — not a pentest verdict"
```

Trend: store `risk_score` per scan, chart last 10 scans per target.

## 7. Out of Scope (v1)

- Active scanning (nmap nuclei intrusive), port-scanning directly — passive OSINT only.
- Multi-user orgs/RBAC beyond `user/admin`.
- PDF export, webhooks, scheduled monitoring (→ v2).
- Mobile native app.

## 8. Acceptance Criteria (verified 2026-09-28; evidence in TODO.md Phase 4)

- [x] Login required to access `/dashboard`; direct URL without session redirects (live 307).
- [x] Scan `example.com` returns Shodan + crt.sh + WHOIS cards in <12s or partial with error badge (live: completed, 12 ports / 10 subs / WHOIS, risk 20, miss 5.2s server-side).
- [x] Charts render with real data, empty state if no data (no crash) — empty states tested (`components.test.ts`).
- [ ] History persists after restart (Postgres), re-open shows identical snapshot (needs Docker Postgres — not available in this env; sqlite history + trend verified live: 3 items / 3 points).
- [x] No API key visible in browser network tab / bundle (grep `.next/static` clean).
- [ ] `docker compose up` + documented `.env` yields working app locally (docker missing in this env; compose file + Dockerfile present, untested).

## 9. Environment Variables

Single source of truth: [backend/.env.example](./backend/.env.example) and [frontend/.env.local.example](./frontend/.env.local.example), documented in [WORKFLOW.md §3](./WORKFLOW.md#3-environment-reference). Do not duplicate env values in this document.

## 10. Milestones

- M1 Scaffold + Auth + DB (week 1)
- M2 3 integrations + orchestrator (week 2)
- M3 Dashboard UI + charts + history (week 3)
- M4 Hardening + tests + docs (week 4)

Related: ARCHITECTURE.md, TODO.md, WORKFLOW.md, AGENTS.md.
