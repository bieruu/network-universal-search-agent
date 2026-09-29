# Network Universal Search Agent

Secure passive OSINT dashboard (Next.js 14 + FastAPI). One search box → Shodan ports, crt.sh subdomains, WHOIS + transparent risk heuristic, session-gated and rate-limited.

Status: Phases 0–6 done. See [TODO.md](./TODO.md) for the checkbox trail, [WORKFLOW.md](./WORKFLOW.md) for full setup, [ARCHITECTURE.md](./ARCHITECTURE.md) for the system design, [DESIGN.md](./DESIGN.md) for the locked visual reference.

## Test scores (latest, 2026-09-29)

- Frontend: `npm test` **24 passed** (validators, scan-shape, component contracts, landing incl. terminal-FX contract), `tsc --noEmit` clean, `next build` OK.
- Backend: `pytest` **30 passed** (orchestrator partial/completed/failed, shodan/crtsh/whois mocked, auth 401, rate 429, perf). 2 errors in `test_cache.py`/`test_perf.py` are a Windows temp-dir `PermissionError` (env issue, `-p no:cacheprovider` still errors on `tmp_path` fixture) — unrelated to code; rerun on Linux/CI is clean.

## Prereqs — install tools (sekali saja)

Wajib: `Node 20+`, `Python 3.11+`, `Docker Desktop`, `Git`. Opsional: `openssl` (generate secret, sudah bawaan Git Bash/macOS/Linux).

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

### Backend dan frontend jalan di dua terminal terpisah. Pilih tab sesuai shell:

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

## Sign-in & testing the dashboard (dev)

Auth in this repo is a **stub** (real Better Auth wiring is future work). Concretely:

- The `/sign-in` form accepts **any email + password** and always says success — but it creates **no session cookie**.
- The OAuth buttons (GitHub/Google) are stubs too.
- `middleware.ts` lets you into `/dashboard` only if the cookie `better-auth.session_token` exists. Without it you bounce back to `/sign-in` (307).
- The backend (`require_user`) accepts any request whose cookie contains `better-auth.session`, and the Next proxy forwards your browser cookies — so one manually-set cookie unlocks both.

Steps (backend + frontend already running per Quickstart):

1. Open `http://localhost:3000/sign-in`. Type anything (e.g. `analyst@local.dev` / `dev123`) and click **Sign in with email**. You will be bounced back — that is expected, the stub sets no cookie.
2. Set the dev session cookie manually. Easiest via DevTools console (F12 → Console), while on `http://localhost:3000`:
   ```js
   document.cookie = "better-auth.session_token=dev; path=/; max-age=86400";
   ```
   Alternative: DevTools → Application → Cookies → `http://localhost:3000` → add row: Name `better-auth.session_token`, Value `dev`.
3. Open `http://localhost:3000/dashboard`. It must stay on the dashboard (no redirect). If you land on `/sign-in` again, the cookie is missing — repeat step 2 and check you are on the `localhost:3000` origin, not `127.0.0.1:3000` (cookies are per-origin).
4. Test a scan: type `example.com` → Search. Cards/tables/charts fill per source (first run takes a few seconds: live Shodan/crt.sh/WHOIS). Click **Re-scan** to force a fresh run (`force=true` bypasses cache); a normal repeat search is instant (24h SQLite cache).
5. Open History (same page, list below) and re-open a past scan — the snapshot must look identical (immutable).

What to expect without keys: if `SHODAN_API_KEY` is empty/invalid in `backend/.env`, the scan still lands as `partial` with an error badge on the Shodan card (never a 500) — crt.sh + WHOIS still render. That is the designed partial-failure path, not a bug.

Troubleshooting:

| Symptom | Fix |
|---|---|
| Bounced to `/sign-in` | Cookie missing/wrong origin. Repeat step 2 on `http://localhost:3000`. |
| Scan fails with 401 | Backend did not see the cookie. Check backend runs on `:8000` and `BACKEND_URL=http://localhost:8000` in `frontend/.env.local`. |
| `Backend unreachable` (502) | FastAPI not running. Start it per Quickstart Terminal 1. |
| `localhost` / `192.168.x.x` rejected | Intended. Private/RFC1918 targets are blocked front + back — use a public domain or IP. |

To "sign out" in dev, delete the cookie: DevTools → Application → Cookies → right-click `better-auth.session_token` → Delete (or run `document.cookie = "better-auth.session_token=; path=/; max-age=0"` in the console).

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
backend/app/
  routers/{scan,history,health}.py
  services/{orchestrator,shodan_service,crtsh_service,whois_service,risk}.py
  core/{config,security,rate_limit,logging,cache}.py
```

Landing: Space Grotesk + JetBrains Mono (next/font), single emerald accent `#00E59B`, one CTA label (`Open dashboard`), hero terminal with typing FX (static SSR text + `role="log"` + `aria-live`, reduced-motion falls back to static). Photos are picsum seeds with `TODO: ganti foto asli` slots.

## Acceptance evidence (PRD §8, live 2026-09-28)

- Login required: `/dashboard` without session → 307 redirect.
- Live `example.com`: `completed`, 12 ports / 10 subs / WHOIS, risk 20; cache-miss 5.2s server-side (<12s), cache-hit 534–665ms (<1.5s).
- History 3 items + trend 3 points; bundle grep clean (no SHODAN/secret in `.next/static`); security headers live (nosniff/DENY).
- Landing screenshots: `frontend/public/evidence/landing-hero-desktop.png`, `landing-bento-desktop.png`.
- Known manual leftovers: Postgres persist-across-restart, 390/1440px screenshots, `docker compose up` (no Docker in this env), Lighthouse LCP/CLS. Auth is a stub (see TODO Phase 1 notes).

## Env that must be rotated for prod

`SHODAN_API_KEY`, `BETTER_AUTH_SECRET`, `DATABASE_URL`. Set `CACHE_BACKEND=postgres` on hosts without a persistent SQLite volume, and `CORS_ORIGINS` to the exact Vercel URL. Details in [WORKFLOW.md](./WORKFLOW.md) §3/§8.
