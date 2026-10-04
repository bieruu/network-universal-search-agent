# Network Universal Search Agent

Secure passive OSINT dashboard (Next.js 15 + FastAPI). One search box → Shodan ports, crt.sh subdomains, WHOIS + transparent risk heuristic, session-gated and rate-limited.

Status: core application, authentication, and dashboard work is implemented; release checks and manual provider/maintainer actions are tracked in [TODO.md](./TODO.md).

See [WORKFLOW.md](./WORKFLOW.md) for full setup, [ARCHITECTURE.md](./ARCHITECTURE.md) for the system design, [DESIGN.md](./DESIGN.md) for the visual reference, and [MANUAL-SETUP.md](./MANUAL-SETUP.md) for verified setup and remaining manual actions.

## Test scores (latest local validation, 2026-10-04)

- Frontend: ESLint, `npm test` (**53 passed**), `npm run tsc`, production build, and `npm audit` passed.
- Backend: full `pytest -q` (49 passed), repository-wide Ruff and Black, and Alembic migration/drift checks passed.

## Prereqs — install tools (sekali saja)

Wajib: `Node 20.6+`, `Python 3.11+`, `Docker Desktop`, `Git`. Opsional: `openssl` (generate secret, sudah bawaan Git Bash/macOS/Linux).

### Windows (winget, PowerShell Admin)

```powershell
winget install OpenJS.NodeJS.LTS Python.Python.3.11 Git.Git Docker.DockerDesktop
```
### Tutup + buka ulang terminal, lalu verifikasi:
```node -v   # >= v20
python --version  # >= 3.11
docker --version
git --version
```

### macOS (brew)

```bash
brew install node@20 python@3.11 git
brew install --cask docker  # lalu buka Docker Desktop sekali
node -v && python3 --version && docker --version && git --version
```

### Linux (apt, Ubuntu/Debian)

```bash
sudo apt update && sudo apt install -y nodejs npm python3 python3-venv git docker.io docker-compose-plugin
node -v && python3 --version && docker --version && git --version
sudo usermod -aG docker $USER  # relogin agar docker tanpa sudo
```

Lalu daftar API key gratis (cukup tier free untuk 1–2 host):
- Shodan: https://account.shodan.io/ → copy key ke `backend/.env` sebagai `SHODAN_API_KEY`.

## Quickstart

### Cara cepat (Windows, 1 perintah): `.\dev.ps1` dari root repo — backend + frontend
nyala bersamaan, venv/deps yang kurang diinstall otomatis, port yang sibuk direbut
kembali, browser terbuka ke halaman pendaftaran Better Auth. Ctrl+C
mematikan dua-duanya. Tanpa browser otomatis: `.\dev.ps1 -NoBrowser`.

### Manual — backend dan frontend jalan di dua terminal terpisah. Pilih tab sesuai shell:

### PowerShell (Windows)

```powershell
Copy-Item frontend\.env.local.example frontend\.env.local
Copy-Item backend\.env.example backend\.env
### Edit: SHODAN_API_KEY, BETTER_AUTH_SECRET (32+ random), DATABASE_URL

docker compose up -d postgres
### DATABASE_URL=postgresql+asyncpg://osint:osint@localhost:5432/osint
```

### Terminal 1 — backend
```powershell
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
### Jika ditolak policy: Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
pip install -r requirements.txt
alembic upgrade head
uvicorn app.main:app --reload --port 8000  # http://localhost:8000/docs
```

### Terminal 2 — frontend
```powershell
cd frontend
npm install
npm run dev  # http://localhost:3000
```

Catatan PowerShell: `&&` untuk merangkai perintah hanya ada di PowerShell 7+ — di Windows PowerShell 5.1 pakai perintah baris-per-baris seperti di atas. `cp`/`cd` adalah alias yang tersedia, tapi `Copy-Item` selalu aman.

### Bash (macOS / Linux / Git Bash)

```bash
cp frontend/.env.local.example frontend/.env.local
cp backend/.env.example backend/.env
# Edit: SHODAN_API_KEY, BETTER_AUTH_SECRET (32+ random), DATABASE_URL

docker compose up -d postgres
# DATABASE_URL=postgresql+asyncpg://osint:osint@localhost:5432/osint
```
### Terminal 1 — backend
```bash 
cd backend && python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
alembic upgrade head
uvicorn app.main:app --reload --port 8000  # http://localhost:8000/docs
```
### Terminal 2 — frontend
```bash
cd frontend && npm install && npm run dev  # http://localhost:3000
```

Flow: sign in → `/dashboard` → search `example.com` → per-card skeletons → charts populate → history saves automatically.
Browser only calls `/api/*` (Next proxy → FastAPI). Never call Shodan/crt.sh directly, never call `:8000` from the browser.

CI runs the frontend and backend checks via `.github/workflows/ci.yml`.

## Sign-in & testing the dashboard (dev)

Authentication uses Better Auth with email/password and PostgreSQL-backed sessions. Create an account at `/sign-up`, then sign in at `/sign-in`. Create the Better Auth tables once in the shared PostgreSQL database:

```bash
cd frontend
npm run auth:migrate
```

The frontend `DATABASE_URL` and backend `DATABASE_URL` must point to the same database (the frontend uses a standard `postgresql://` URL; the backend uses `postgresql+asyncpg://`). FastAPI validates the session token against the active Better Auth session row and its expiry; a cookie's name or contents alone do not grant access. Dashboard middleware calls the Better Auth session endpoint, and protected API requests are independently checked by FastAPI.

Google and GitHub sign-in are available only after their client IDs and secrets are configured. Without those credentials, the provider returns an explicit unavailable/error response; no OAuth live flow is claimed.

After signing in, test a scan: type `example.com` → Search. Cards/tables/charts fill per source (first run takes a few seconds: live Shodan/crt.sh/WHOIS). Click **Re-scan** to force a fresh run (`force=true` bypasses cache); a normal repeat search uses the cache. Open History and re-open a past scan — the snapshot must look identical (immutable).

What to expect without keys: if `SHODAN_API_KEY` is empty/invalid in `backend/.env`, the scan still lands as `partial` with an error badge on the Shodan card (never a 500) — crt.sh + WHOIS still render. That is the designed partial-failure path, not a bug.

Troubleshooting:

| Symptom | Fix |
|---|---|
| Bounced to `/sign-in` | Session is missing/expired, or `BETTER_AUTH_URL` and browser origin do not match. Sign in again using the configured app URL. |
| Scan fails with 401 | Backend did not see the cookie. Check backend runs on `:8000` and `BACKEND_URL=http://localhost:8000` in `frontend/.env.local`. |
| Scan fails with 503 | Backend is not configured with the shared PostgreSQL session store; set backend `DATABASE_URL` to the same DB as frontend (using the `+asyncpg` SQLAlchemy scheme). |
| `Backend unreachable` (502) | FastAPI not running. Start it per Quickstart Terminal 1. |
| `localhost` / `192.168.x.x` rejected | Intended. Private/RFC1918 targets are blocked front + back — use a public domain or IP. |
| `next dev` / `next build` crashes on start with `EINVAL: invalid argument, readlink ...\.next\...` | Repo lives under OneDrive: "Files On-Demand" turns `.next` internals into placeholder files and Next's own cleanup chokes on them. `npm run dev` / `npm run build` now auto-clean `.next` on Windows+OneDrive (`frontend/scripts/clean-next.mjs`, hooked via `predev`/`prebuild`). Manual fallback: `npm run clean`, or move the repo outside OneDrive. |
| `pnpm: command not found` | This repo's lockfile is npm (`frontend/package-lock.json`). Use `npm install` / `npm run dev`; or enable pnpm first via `corepack enable pnpm`. |

Use the dashboard's **Log out** action to revoke the current Better Auth session.

## Structure

```
frontend/app/
  page.tsx                        # public landing (dark-lock #0a0f14)
  _components/landing/            # Nav, Hero, TerminalTyper, Reveal,
                                  # LogoStrip, FeatureBento, HowItWorks,
                                  # SecurityStrip, CtaFooter
  (dashboard)/dashboard/          # TargetSearch, ScanStatus, OverviewCards,
                                  # PortsTable, SubdomainsTable, WhoisCard,
                                  # PortsChart, RiskTrendChart (ssr:false)
  api/scan/[[...path]]/route.ts   # session proxy → FastAPI
  api/auth/[...all]/route.ts      # Better Auth endpoints
backend/app/
  routers/{scan,history,health}.py
  services/{orchestrator,shodan_service,crtsh_service,whois_service,risk}.py
  core/{config,security,rate_limit,logging,cache}.py
```

Landing: Space Grotesk + JetBrains Mono (next/font), single emerald accent `#00E59B`, one CTA label (`Open dashboard`), hero terminal with typing FX (static SSR text + `role="log"` + `aria-live`, reduced-motion falls back to static). No placeholder photo scaffolding remains in the landing layout.

## Acceptance evidence

- Login, protected scan, session revocation, and owner isolation have been verified; see [TODO.md](./TODO.md) for evidence.
- The PostgreSQL-backed backend image has been built and includes Subfinder v2.16.0.
- OAuth provider callbacks, maintainer license approval, and any outstanding release checks are listed in [MANUAL-SETUP.md](./MANUAL-SETUP.md).

## Env that must be rotated for prod

`SHODAN_API_KEY`, `BETTER_AUTH_SECRET`, `DATABASE_URL`. Set `CACHE_BACKEND=postgres` on hosts without a persistent SQLite volume, and `CORS_ORIGINS` to the exact Vercel URL. Details in [WORKFLOW.md](./WORKFLOW.md) §3/§8.
