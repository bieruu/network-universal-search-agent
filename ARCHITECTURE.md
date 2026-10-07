# ARCHITECTURE — Network Universal Search Agent

## 1. System Overview

```
[ Browser: Next.js App Router ] 
   │ Better Auth session + fetch via /api/* (Next proxy)
   ▼
[ Next Route Handlers (/api/* proxy) ] ── verifies session ──▶ [ FastAPI :8000 /api/v1/* ]
                                                                      │ asyncio.gather
                                    ┌─────────────────┬────────────────┼──────────────┐
                                    ▼                 ▼                ▼              ▼
                              Shodan API      crt.sh / Cert Spotter  WHOIS lib     SQLite cache (TTL 24h)
                                    │                 │                │              │
                                    └─────────────────┴────────────────┴──────┬───────┘
                                                                              ▼
                                                              PostgreSQL (users/targets/scans/findings)
```

Principles:
- Secrets never leave backend. Frontend never calls external OSINT providers directly.
- FastAPI is stateless orchestrator; Postgres is source of truth; SQLite is quota-saving cache.
- Partial failure is first-class: `partial` status + per-source errors.

## 2. Repository Layout (Clean, Modular)

```
/
├── PRD.md ARCHITECTURE.md AGENTS.md TODO.md WORKFLOW.md
├── docker-compose.yml
├── frontend/                       # Next.js
│   ├── app/
│   │   ├── (auth)/sign-in/page.tsx
│   │   ├── (dashboard)/dashboard/page.tsx
│   │   │   ├── TargetSearch.tsx     # input + validation (zod)
│   │   │   ├── ScanStatus.tsx       # polling
│   │   │   └── _components/
│   │   │       ├── OverviewCards.tsx
│   │   │       ├── PortsTable.tsx
│   │   │       ├── SubdomainsTable.tsx
│   │   │       ├── WhoisCard.tsx
│   │   │       ├── PortsChart.tsx   # doughnut + bar (chart.js)
│   │   │       └── RiskTrendChart.tsx
│   │   ├── api/scan/[...path]/route.ts  # proxy → FastAPI, attaches session
│   │   ├── layout.tsx  globals.css (dark default)
│   │   └── middleware.ts (Better Auth guard)
│   ├── components/ui/              # shadcn/ui (button, card, table, badge, skeleton, chart wrapper)
│   ├── lib/{auth-client.ts, api.ts, utils.ts, validators.ts}
│   └── .env.local.example
└── backend/
    ├── app/
    │   ├── main.py                 # FastAPI factory, CORS, lifespan, routers
    │   ├── core/{config.py, security.py, rate_limit.py, logging.py, cache.py}
    │   ├── routers/{scan.py, history.py, health.py}
    │   ├── services/{orchestrator.py, shodan_service.py, crtsh_service.py,
    │   │            certspotter_service.py, subfinder_service.py,
    │   │            whois_service.py, nvd_service.py, cpe_util.py, risk.py}
    │   ├── models/{target.py, scan.py, finding.py}  # SQLAlchemy 2.0
    │   ├── schemas/{scan.py, common.py}             # Pydantic v2
    │   └── db/{session.py, base.py}
    ├── alembic/
    ├── data/.gitkeep              # SQLite file lives here (gitignored)
    ├── requirements.txt
    └── .env.example
```

## 3. Frontend Design

- **Routing:** App Router groups `(auth)` public, `(dashboard)` protected. `middleware.ts` checks Better Auth session.
- **Data fetching:** Client components use SWR/poll every 2s on `GET /api/scan/{id}` until `completed|partial|failed`. Server components for history list (SSR via FastAPI `GET /history`).
- **UI:** Tailwind dark class default (`<html class="dark">`), shadcn `Card, Table, Badge, Skeleton, Tabs`. Charts lazy-loaded (`next/dynamic ssr:false`) to avoid hydration mismatch.
- **Validation:** `z.object({ target: z.string().regex(/^(?:[a-z0-9-]+\.)+[a-z]{2,}$|^(?:\d{1,3}\.){3}\d{1,3}$/i) })`, block `localhost, 10/8, 192.168/16, 172.16/12`.

## 4. Backend Design (FastAPI Async)

### 4.1 API Contract (v1)

```
POST /api/v1/scan            { target, force?:bool } → { scan_id, status }
GET  /api/v1/scan/{id}       → { scan_id, target, status, risk_score, results:{shodan,crtsh,whois}, errors[] }
GET  /api/v1/history?target=&page=&limit= → { items[], total }
GET  /api/v1/target/{t}/trend → { points: [{scan_id, created_at, risk_score}] }
GET  /health /ready
```

Pydantic example:

```python
class ScanRequest(BaseModel):
    target: str = Field(pattern=r"^(?:[a-z0-9-]+\.)+[a-z]{2,}$|^(?:\d{1,3}\.){3}\d{1,3}$")
    force: bool = False

class ScanResult(BaseModel):
    scan_id: UUID; target: str; status: Literal["pending","running","completed","partial","failed"]
    risk_score: int | None; results: dict; errors: list[SourceError]
```

### 4.2 Orchestrator (core logic)

`services/orchestrator.py`:

```python
async def run_scan(target, force=False):
    scan_id = new_uuid(); persist(status="running")
    if not force: check sqlite cache per source
    sh, ct, wh = await asyncio.gather(
        with_timeout(shodan_service.lookup(target), 12),
        with_timeout(crtsh_service.lookup(target), 15),
        with_timeout(whois_service.lookup(target), 10),
        return_exceptions=True)
    normalize → risk.py score → persist scans + findings (JSONB snapshot, immutable)
    return aggregated
```

- Timeout per source, `return_exceptions=True`, exception → `{ source, message }` in `errors[]`.
- httpx.AsyncClient shared, connection pool, UA `osint-dashboard/1.0`, 2 retries with backoff for 429/5xx (crt.sh flaky).
- Never trust external JSON: Pydantic parse + `.get()` defaults + truncate banners to 2KB.

### 4.3 Services Detail
- **Shodan:** `https://api.shodan.io/shodan/host/{ip}?key=` — if target is domain, resolve DNS first, then re-check the resolved address. Map `ports, data[{port, transport, product, version, banner, cpes}], vulns, cpes, isp, asn, city/country`. Only exact `cpe:2.3:` identifiers are kept (keyword/product matching rejected). On HTTP 403 or 404, fall back to Shodan's public, keyless InternetDB endpoint for ports, vulnerability identifiers, and CPEs; label fallback data and treat its 404 as no indexed result.
- **NVD CVE enrichment:** after Shodan succeeds, `nvd_service.enrich_cpes(shodan.cpes)` queries `GET https://services.nvd.nist.gov/rest/json/cves/2.0?cpeName=<exact CPE>` (never `isVulnerable` — verified unstable 2026-10-05).
  - Client-side filter keeps only CVEs whose `configurations[].nodes[].cpeMatch[]` has `vulnerable=true` matching the observed CPE (exact criteria or provable version-range containment).
  - Result contract: `results.nvd = { source, status: found|no_match|insufficient_evidence|unavailable, checked_cpes[], cves[{id, description, cvss, severity, published, references[], evidence_cpe}], truncated, errors[], note }`.
  - Caps & limits: `NVD_MAX_CPES=5`, `NVD_CVES_PER_CPE=20`, page `NVD_PAGE_SIZE=100`; sequential requests with 6s delay (0.7s with `NVD_API_KEY`); per-CPE cache 7d; timeout `SCAN_TIMEOUT_NVD=12`.
  - Errors: NVD 404 with empty body = `no_match`; timeouts/429/5xx = `unavailable` (+ `errors[]`, scan stays `partial`).
  - Risk scoring unions `shodan.vulns` + `nvd.cves` and flags `breakdown.vulns_incomplete` when coverage is missing — missing data never renders as `0`.

- **CVE validity tiers (Phase 17, 2026-10-05):** `nvd_service.build_cve_rows(shodan.vulns, nvd, client)` cross-checks each Shodan-reported CVE ID against NVD (`GET ...?cveId=<id>`, cap `NVD_CVE_ID_LOOKUP_CAP=20`/scan, per-ID cache 7d keyed `nvd:cve:<id>`).
  - Row contract: `results.nvd.cve_rows[] = {id, tier, source, severity, cvss, evidence_cpe, vuln_status, description, url}`.
  - Tiers: `verified` (NVD CPE-exact match, or ID cross-checked with non-rejected status) · `unverified` (ID valid-looking but not confirmed: NVD down, cap hit, or CPE mismatch) · `rejected` (NVD `vulnStatus` Rejected/Disputed — shown in UI, excluded from scoring).
  - NVD total failure degrades every Shodan ID to `unverified`, never hidden. `risk.score` counts only `verified`+`unverified` IDs, reports `breakdown.rejected_cves`, and keeps `vulns_incomplete`.
  - CPE 2.2 URIs (`cpe:/a:vendor:...`) are normalized to CPE 2.3 by `services/cpe_util.py:normalize_cpe` (deterministic 1-to-1, missing segments → `*`), accepted by both Shodan CPE collection and NVD validation — this unblocks InternetDB hosts that only emit `cpe:/...`.
  - UI: `VulnerabilitiesCard` renders columns CVE (NVD link) / Tier badge / Severity / CVSS / Evidence CPE / Source, plus a tier legend; `getCveEvidence` excludes `rejected` IDs from the dashboard count. No new env vars; fallback chain (crt.sh → Cert Spotter → Subfinder) unchanged.
- **Certificate Transparency:** query crt.sh first; on failure use the public Cert Spotter API, then the bounded Subfinder CLI. Successful fallback data is cached and identifies its provider; report an error only when all passive certificate sources fail. Results deduplicate and cap names at 500, retaining `{ subdomain, issuer, not_before/after }`.
- **WHOIS:** `python-whois` in `asyncio.to_thread` (blocking) — map registrar, creation/expiry, name_servers, emails (may be None due to GDPR — show "redacted").

## 5. Data Model (PostgreSQL)

```sql
targets(id UUID PK, value TEXT UNIQUE, type TEXT, first_seen TIMESTAMPTZ, last_scan_at TIMESTAMPTZ);
scans(id UUID PK, target_id FK, user_id TEXT, status TEXT, risk_score INT,
      result_snapshot JSONB NOT NULL, errors JSONB DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT now(), completed_at TIMESTAMPTZ);
findings(id UUID PK, scan_id FK, source TEXT, kind TEXT, severity TEXT, data JSONB);
-- Better Auth manages users table separately.
CREATE INDEX ON scans(target_id, created_at DESC);
```

SQLite cache (separate file, not migrated):

```sql
CREATE TABLE IF NOT EXISTS cache(key TEXT PRIMARY KEY, payload TEXT, expires_at INTEGER);
-- key = 'shodan:1.1.1.1', payload = raw JSON string
```

## 6. Auth & Security

- Better Auth (OAuth + email/password) issues session cookie (httpOnly, Secure, SameSite=Lax).
- Next `middleware.ts` guards `/dashboard/*` and fails closed (503) when `BETTER_AUTH_URL` is non-localhost plain http in production. Next proxy `app/api/scan/[...path]/route.ts` reads session, forwards it (cookie / `Authorization` header) to FastAPI.
- FastAPI `core/security.py: require_user()` verifies the Better Auth session via the shared secret + shared PostgreSQL session store; rejects missing/invalid with 401. Enforces per-user rate limit (in-memory fixed window; see limitation below).
- Machine-to-machine access uses a dedicated `SERVICE_TOKEN` env (`Authorization: Bearer <token>` → `user:service`); the session-signing `BETTER_AUTH_SECRET` is never accepted as an API key.
- **Known limitation — rate limiting:** `app/core/rate_limit.py` is a per-process in-memory fixed window. Counters reset on restart and are not shared across uvicorn workers, so every bound below multiplies with worker count. Run a single worker in production (the default) or move the counter to Redis/Postgres before scaling out (v2).
  - Buckets are per-user, so the quota is also per account: N accounts mean N × `RATE_LIMIT_PER_HOUR` scans per hour against one Shodan key. The per-account window cannot express a budget for the shared key, which is what `RATE_LIMIT_DAILY_TOTAL` exists for — an opt-in instance-wide ceiling on *admitted* scans per rolling 24h, counted in hourly buckets so the counter itself stays bounded. Disabled by default (0), because the right number is a billing decision.
  - Production refuses to boot unless `RATE_LIMIT_PER_HOUR` is set in the process environment and is at most `PRODUCTION_RATE_LIMIT_CEILING` (5). An unset quota is a silent budget decision on a paid API key. The constant lives in code so raising it is a reviewable change rather than a quiet env edit.
  - `RATE_LIMIT_MAX_KEYS` (default 10000) is the absolute ceiling on live bucket keys. The periodic sweep only bounds growth relative to arrival rate — "keys touched in the last ~65 minutes" — not absolute size. At the cap, an *unknown* key is refused with 429 until the next sweep. Fail closed on purpose: LRU eviction would reset a live user's remaining quota, so anyone able to mint keys could mint free scans. The cost is that a signup burst can lock out new users for up to one sweep interval; existing accounts are never affected.
  - **Account-age quota weighting was evaluated and rejected.** The limiter receives the opaque string `user:<better-auth-user-id>` and has no DB session, so weighting a new account's quota by its age needs an awaitable query on the hot path of every scan, in a module that is currently synchronous and dependency-free — and it still fails open exactly when the DB is down. The instance daily cap covers the same blast-radius concern without the per-request cost.
- **Known limitation — CSP is report-only, so XSS enforcement is absent:** `frontend/next.config.mjs` sends `Content-Security-Policy-Report-Only`. The policy is telemetry; the browser does not block anything. Enforcement needs a nonce for Next's own inline hydration scripts (`self.__next_f`). Do not list CSP as an active control in a production risk register — the other headers it ships with (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, HSTS) are enforced, the CSP itself is not.
- **Known limitation — every `SERVICE_TOKEN` shares one identity:** `app/core/security.py` returns `user:service` for any `Authorization: Bearer` value matching `SERVICE_TOKEN`. All machine-to-machine scans therefore land on one owner, one history row per target, and one rate-limit bucket. Acceptable while there is a single consumer; more than one consumer needs a per-token identity before it ships.
- **Target validation has two layers.** `assert_target_allowed` checks the literal string (catches `localhost`, RFC1918, link-local, IPv6 ranges); `assert_resolved_target_allowed` additionally resolves a hostname and re-checks the address it points at, so a public-looking name pointing at `127.0.0.1` or `169.254.169.254` is rejected. Resolution runs through `asyncio.to_thread` under a `wait_for` bound (`SCAN_TIMEOUT_SHODAN`) — `gethostbyname` blocks for as long as the resolver takes and would otherwise stall the whole worker (AGENTS.md §3).
- The resolved-IP check runs in `routers/scan.py`, **not** in a source service: the orchestrator folds every source exception into `errors[]` and still answers `200`, so an `HTTPException` raised inside a service can never reach the client. `shodan_service.lookup` keeps its own `assert_target_allowed(resolved_ip)` as the enforcement point that guarantees no request is sent upstream.
- It sits **after** `check_rate_limit` deliberately. It costs a DNS query, so placing it ahead of the limiter would hand out a free oracle for enumerating internal names; rate-limited callers only pay for it. The consequence is that a blocked target still consumes one rate-limit stamp.
- Hardening: CORS allowlist only `APP_URL`, `TrustedHost`, Pydantic input regex + block private ranges, ORM parametrized, no `eval`, banners rendered as text (no `dangerouslySetInnerHTML`), structlog without passwords/keys, `X-Request-ID` tracing.

## 7. Observability & Config

- `/health` (liveness, no DB), `/ready` (DB + SQLite ping).
- JSON logs: `{ request_id, user_id, target, source, latency_ms, status }`.
- Config via `pydantic-settings`, all secrets from env, `.env.example` committed, `.env` gitignored.
- Cache backend flag: `CACHE_BACKEND=sqlite|postgres` (`app/core/config.py`). `sqlite` = local file at `SQLITE_PATH`; `postgres` = `osint_cache` table via asyncpg (DSN derived from `DATABASE_URL`, `CREATE TABLE IF NOT EXISTS`, 2s timeout). Async entry points `cache_get_async`/`cache_set_async` in `app/core/cache.py` (orchestrator uses these; sync helpers kept for compat). Either backend failing never fails a scan — get returns `None`, set swallows.

## 8. Deployment

- Local: `docker compose up postgres` + `uvicorn` + `npm run dev` (see WORKFLOW.md).
- Prod minimal: Frontend on Vercel, FastAPI on Fly/Render (Docker), Postgres managed (Neon/Supabase). CORS + `APP_URL` updated. SQLite replaced by Postgres cache table or Redis in prod (env flag `CACHE_BACKEND=sqlite|postgres` — set `postgres` on hosts without a persistent volume; the table is auto-created, see §7).
- **Known limitation — migrations run in the container CMD:** `backend/Dockerfile` ends with `python -m alembic upgrade head && python -m uvicorn ...`. Correct for a single replica, but concurrent replicas race on the same DDL during a scale-out, and the release step in WORKFLOW.md §8.2 (step 2) runs the same migration independently. Keep one replica until migrations move out of the CMD into a dedicated release step.

## 9. Trade-offs & v2

- SQLAlchemy chosen over Prisma for single Python stack; Prisma viable if BFF moves to Node.
- Polling over WebSocket for simplicity; upgrade to SSE when scan >15s common.
- v2: scheduled monitoring, diff alerts, PDF export, org RBAC, Nuclei passive checks.
