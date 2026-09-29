# WORKFLOW — Dev, Run, Ship

## 1. Prereqs

- Node 20+ (pnpm), Python 3.11+, Docker (for Postgres)
- Shodan API key: https://account.shodan.io/ (free tier OK for 1-2 hosts)

## 2. First-Time Setup

```bash
# 1. Clone + env
git clone <repo> network-universal-search-agent && cd network-universal-search-agent
cp frontend/.env.local.example frontend/.env.local
cp backend/.env.example backend/.env
# Edit: SHODAN_API_KEY, BETTER_AUTH_SECRET (32+ random), DATABASE_URL

# 2. DB
docker compose up -d postgres
# DATABASE_URL=postgresql+asyncpg://osint:osint@localhost:5432/osint

# 3. Backend
cd backend && python -m venv .venv && source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
alembic upgrade head
uvicorn app.main:app --reload --port 8000  # http://localhost:8000/docs

# 4. Frontend (new terminal)
cd frontend && pnpm install && pnpm dlx shadcn@latest init -y
pnpm dev  # http://localhost:3000
```

Minimal `requirements.txt`:

```
fastapi uvicorn[standard] httpx pydantic-settings sqlalchemy[asyncio]
asyncpg alembic python-whois structlog python-dotenv
pytest pytest-asyncio respx
```

## 3. Env Reference

```bash
# frontend/.env.local
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_API_URL=http://localhost:3000/api
BETTER_AUTH_SECRET=dev-secret-min-32-chars-change-me
BETTER_AUTH_URL=http://localhost:3000
DATABASE_URL=postgresql+asyncpg://osint:osint@localhost:5432/osint

# backend/.env
SHODAN_API_KEY=xxx
DATABASE_URL=postgresql+asyncpg://osint:osint@localhost:5432/osint
SQLITE_PATH=./data/cache.db
CACHE_BACKEND=sqlite  # postgres in prod (no volume) — uses osint_cache table
BETTER_AUTH_SECRET=same-as-frontend
CORS_ORIGINS=http://localhost:3000
SCAN_TIMEOUT_SHODAN=12
SCAN_TIMEOUT_CRTSH=15
SCAN_TIMEOUT_WHOIS=10
RATE_LIMIT_PER_HOUR=10
```

Generate secret: `openssl rand -base64 32`.

## 4. Daily Run

```bash
docker compose up -d postgres
# T1 backend
cd backend && source .venv/bin/activate && uvicorn app.main:app --reload --port 8000
# T2 frontend
cd frontend && pnpm dev
```

Flow: Sign in → `/dashboard` → type `example.com` → watch per-card skeletons → charts populate → History saves automatically.

Proxy: browser → `Next /api/scan/*` (attaches session) → `FastAPI /api/v1/scan/*`. Never call `:8000` directly from browser in dev.

## 5. Branching & Commits

```bash
git checkout -b feat/shodan-service
# ... code + tests ...
pnpm lint && pnpm tsc --noEmit
pytest -q && ruff check . && black --check .
git commit -m "feat: shodan lookup with timeout + cache"
gh pr create --fill
```

Branches: `feat/*`, `fix/*`, `chore/*`, `docs/*`. One concern per PR. Update TODO.md checkbox in same PR.

## 6. Testing & Checks

```bash
# Backend — mock external, test partial
pytest -q -k "orchestrator or shodan or auth"
# Frontend
pnpm test && pnpm lint
# Manual partial: stop network to crt.sh OR set SHODAN_API_KEY=invalid → expect status=partial + badge, not 500
# Secrets check
grep -r "SHODAN_API_KEY" frontend/.next frontend/src --include="*.js" --include="*.tsx" | head
```

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| `401 on /scan` | Sign in again; check `BETTER_AUTH_SECRET` matches FE/BE; inspect cookie Secure on http (set false locally) |
| `crt.sh timeout` | Normal flakiness → retry, check `errors[]`; increase `SCAN_TIMEOUT_CRTSH=20` |
| `Shodan 401` | Invalid key; verify at `https://api.shodan.io/api-info?key=` |
| `WHOIS empty emails` | GDPR redacted — expected, show "redacted" |
| `DB connect refused` | `docker compose ps`, `alembic upgrade head`, check `DATABASE_URL` asyncpg scheme |
| `CORS blocked` | `CORS_ORIGINS` must exactly match `http://localhost:3000` |
| `Charts hydration error` | Ensure `next/dynamic(..., {ssr:false})` for chart components |

## 8. Ship

- FE → Vercel: import `frontend/`, set env `NEXT_PUBLIC_*`, `BETTER_AUTH_*` (`BETTER_AUTH_URL` = Vercel URL), redeploy.
- DB → Neon/Supabase: create project, copy pooled connection string into both `DATABASE_URL`s (SQLAlchemy `+asyncpg` scheme on backend), run `alembic upgrade head` from `backend/`.
- BE → Docker/Fly: `cd backend` then `docker build -t osint-be .` + `docker run -e PORT=8000 --env-file .env -p 8000:8000 osint-be` (image runs `alembic upgrade head` then uvicorn on `$PORT`). Fly: `fly launch --dockerfile Dockerfile` with secrets `SHODAN_API_KEY`, `DATABASE_URL`, `BETTER_AUTH_SECRET`.
- Prod: set `CACHE_BACKEND=postgres` if SQLite volume not persisted (auto-creates `osint_cache` table); rotate `BETTER_AUTH_SECRET` + `SHODAN_API_KEY` via provider dashboard. Set `CORS_ORIGINS` to the Vercel URL exactly.
