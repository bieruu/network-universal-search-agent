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
                              Shodan API           crt.sh           WHOIS lib     SQLite cache (TTL 24h)
                                    │                 │                │              │
                                    └─────────────────┴────────────────┴──────┬───────┘
                                                                              ▼
                                                              PostgreSQL (users/targets/scans/findings)
```

Principles:
- Secrets never leave backend. Frontend never calls Shodan/crt.sh directly.
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
    │   ├── routers/{scan.py, shodan.py, crtsh.py, whois.py, history.py, health.py}
    │   ├── services/{orchestrator.py, shodan_service.py, crtsh_service.py, whois_service.py, risk.py}
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
- **Data fetching:** Client components use SWR/poll every 2s on `GET /api/scan/{id}` until `completed|partial|failed`. Server components for history list (SSR from Postgres via Drizzle/Prisma optional, or via FastAPI `GET /history`).
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
- **Shodan:** `https://api.shodan.io/shodan/host/{ip}?key=` — if target is domain, resolve DNS first (socket, logged). Map `ports, data[{port, transport, product, version, banner}], vulns, isp, asn, city/country`.
- **crt.sh:** `GET https://crt.sh/?q=%25.{domain}&output=json` — dedup `name_value` split lines, lowercase, strip `*.`, collect `{ subdomain, issuer, not_before/after }`. Limit 500 rows.
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
- Next `middleware.ts` guards `/dashboard/*`. Next proxy `app/api/scan/[...path]/route.ts` reads session, forwards `Authorization: Bearer <session-token>` or cookie to FastAPI.
- FastAPI `core/security.py: require_user()` verifies via Better Auth JWKS/shared secret; rejects missing/invalid with 401. Enforces per-user rate limit (in-memory + Postgres counter, or Redis later).
- Hardening: CORS allowlist only `APP_URL`, `TrustedHost`, Pydantic input regex + block private ranges, ORM parametrized, no `eval`, banners rendered as text (no `dangerouslySetInnerHTML`), structlog without passwords/keys, `X-Request-ID` tracing.

## 7. Observability & Config

- `/health` (liveness, no DB), `/ready` (DB + SQLite ping).
- JSON logs: `{ request_id, user_id, target, source, latency_ms, status }`.
- Config via `pydantic-settings`, all secrets from env, `.env.example` committed, `.env` gitignored.
- Cache backend flag: `CACHE_BACKEND=sqlite|postgres` (`app/core/config.py`). `sqlite` = local file at `SQLITE_PATH`; `postgres` = `osint_cache` table via asyncpg (DSN derived from `DATABASE_URL`, `CREATE TABLE IF NOT EXISTS`, 2s timeout). Async entry points `cache_get_async`/`cache_set_async` in `app/core/cache.py` (orchestrator uses these; sync helpers kept for compat). Either backend failing never fails a scan — get returns `None`, set swallows.

## 8. Deployment

- Local: `docker compose up postgres` + `uvicorn` + `pnpm dev` (see WORKFLOW.md).
- Prod minimal: Frontend on Vercel, FastAPI on Fly/Render (Docker), Postgres managed (Neon/Supabase). CORS + `APP_URL` updated. SQLite replaced by Postgres cache table or Redis in prod (env flag `CACHE_BACKEND=sqlite|postgres` — set `postgres` on hosts without a persistent volume; the table is auto-created, see §7).

## 9. Trade-offs & v2

- SQLAlchemy chosen over Prisma for single Python stack; Prisma viable if BFF moves to Node.
- Polling over WebSocket for simplicity; upgrade to SSE when scan >15s common.
- v2: scheduled monitoring, diff alerts, PDF export, org RBAC, Nuclei passive checks.
