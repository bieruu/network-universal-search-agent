# Network Universal Search Agent

[![CI](https://github.com/bieruu/network-universal-search-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/bieruu/network-universal-search-agent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

**See what the internet already says about a domain, before you point anything at it.**

Enter one domain or public IP and get a single report: which ports public scan indexes have seen, which names sit under the domain in the public certificate log, who registered it, what DNS records it publishes, which known vulnerabilities match the software visible on it, and a 0 to 100 risk score built from those findings. Every report is stored, so you can reopen it later or compare it with the same target's previous result.

![Landing page](frontend/public/evidence/landing-hero-desktop.png)

## Overview

Checking one domain usually means visiting several unrelated tools and reconciling their output by hand. This project queries the public sources it is configured with, normalizes the replies, scores them with one model, and keeps the result in one history that can be exported.

The intended users are security analysts, SOC teams, bug-bounty hunters and IT administrators doing authorized reconnaissance on their own or a client's public-facing estate. It also serves as a working reference for aggregating untrusted third-party data behind a typed API.

The tool is strictly passive. It reads what Shodan, public certificate transparency logs, WHOIS, DNS and NVD already publish. It never port-scans or probes the target, so an empty card means "nothing in these public records", never "nothing is there".

## Demo

There is no public deployment URL in this repository. To see the interface without configuring anything, run the app locally and open:

| Route | What it shows |
|---|---|
| `/` | Landing page with a working terminal replay built from static fixtures |
| `/demo` | A complete sample report for three example sites. No account, no backend, no scan. |
| `/dashboard` | The live dashboard. Signed out, you can run a small number of real scans per day; results are not saved to history. |

The demo report is clearly labelled sample data, and any fixture value that is missing is stated as missing rather than invented.

![Signed-out dashboard](frontend/public/evidence/guest-dashboard-dark.png)

## What one search gives you

- **Ports and software.** What public scan records show open, and what software and version answers on each port.
- **Subdomains.** Names that appear in public certificates, including ones not linked from any page.
- **Domain registration.** Registrar, creation date, expiry date and nameservers.
- **DNS records.** A, AAAA, MX, NS, TXT, CNAME and SOA.
- **Known issues.** CVEs from NVD matched against the detected software, with severity.
- **A risk score you can argue with.** 0 to 100, with the findings that produced the number.
- **History and trend.** Every scan is stored immutably, so a re-scan is a new row and the trend line shows movement.
- **Findings you can hand over.** Export a report as JSON, Markdown or PDF, generated in the browser.

## How it behaves when a source fails

Failures are part of the contract, not an exception path:

- A slow or unreachable source never blanks the report. The response stays HTTP 200 with `status: "partial"` and one entry in `errors[]` per failed source (`{"source": "...", "message": "..."}`).
- Each card states what it could not check. Empty states say what the absence of a record proves, which for passive sources is usually very little.
- External payloads are parsed and bounded before they reach the UI, so a source returning junk or a huge banner degrades that card only.

## Technology stack

| Layer | Choice |
|---|---|
| Frontend | Next.js 15 (App Router), React 19, TypeScript (strict), Tailwind CSS 4, shadcn/ui on Radix primitives |
| Charts | Chart.js via `react-chartjs-2` |
| Auth | Better Auth (email/password plus optional Google and GitHub OAuth) |
| Backend | FastAPI, Pydantic v2, SQLAlchemy 2 (async), Alembic, httpx |
| Database | PostgreSQL 16 (scan history and auth tables) |
| Cache | SQLite file by default, or PostgreSQL via `CACHE_BACKEND=postgres` |
| Tests | `pytest` and `pytest-asyncio` for the backend, Node's built-in test runner for the frontend |

## Prerequisites

- **Node.js 22.18 or newer.** The frontend test suite runs `.ts` files directly, which needs Node's type stripping (unflagged from 22.18). Node 20 fails with `ERR_UNKNOWN_FILE_EXTENSION`.
- **Python 3.11 or newer.**
- **Docker** with Compose, for the local PostgreSQL container. Any reachable PostgreSQL 16 instance works instead.
- **Git.**

## Local setup

The commands below are PowerShell. On macOS or Linux use `cp` instead of `Copy-Item` and the usual virtualenv activation.

```powershell
git clone https://github.com/bieruu/network-universal-search-agent.git
cd network-universal-search-agent
```

### 1. Configuration and database

```powershell
Copy-Item frontend\.env.local.example frontend\.env.local
Copy-Item backend\.env.example backend\.env

# Generate a secret and use the same value for both apps
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

Set `BETTER_AUTH_SECRET` in **both** `.env` files to that generated value, and set `SHODAN_API_KEY` in `backend/.env`. Then start PostgreSQL:

```powershell
$env:POSTGRES_PASSWORD = "pick-a-local-password"
docker compose up -d postgres
```

`docker-compose.yml` refuses to start without `POSTGRES_PASSWORD`. The password you choose here must also appear in `DATABASE_URL` in `backend/.env` (and in `frontend/.env.local`, which uses the plain `postgresql://` scheme rather than `postgresql+asyncpg://`).

### 2. Backend

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements-dev.txt
alembic upgrade head
uvicorn app.main:app --reload --port 8000
```

- `http://localhost:8000/health` returns `{"status":"ok"}` when the process is up.
- `http://localhost:8000/docs` serves the OpenAPI UI in development. It is disabled when the app runs in production mode.

### 3. Frontend

In a second terminal:

```powershell
cd frontend
npm install
npm run auth:migrate
npm run dev
```

`npm run auth:migrate` creates the Better Auth tables (`user`, `session`, `account`, `verification`) in the configured database. It reads `DATABASE_URL` from `frontend/.env.local`.

Open `http://localhost:3000`, sign up, and scan `example.com`.

### Shortcut for Windows

`.\dev.ps1` installs missing dependencies, reclaims ports 3000 and 8000 if they are busy, starts both servers, waits for both health checks, and opens the sign-up page. `.\dev.ps1 -NoBrowser` skips the browser.

### If you do not have a Shodan key

The scan still completes as a partial report. The Shodan card shows an error badge while the certificate log, WHOIS and DNS cards fill in. That is designed behaviour.

## Configuration

Both apps read their `.env` file at startup. The full annotated list lives in [`backend/.env.example`](backend/.env.example) and [`frontend/.env.local.example`](frontend/.env.local.example); the values you must set to boot locally are below.

### Backend (`backend/.env`)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Async SQLAlchemy URL. Must use the `postgresql+asyncpg://` driver; a plain `postgresql://` URL fails at boot. |
| `SHODAN_API_KEY` | Shodan access. A missing or invalid key yields a partial scan, not a crash. |
| `BETTER_AUTH_SECRET` | Shared secret used to verify Better Auth sessions. At least 32 characters, identical to the frontend value. |
| `CACHE_BACKEND` | `sqlite` (default, file at `SQLITE_PATH`) or `postgres` for hosts without a persistent volume. |
| `CORS_ORIGINS` | Allowed browser origin, for example `http://localhost:3000`. Exact origin, no wildcard. |
| `APP_URL` | Public URL of the frontend, used in generated links. |
| `RATE_LIMIT_PER_HOUR` | Scans per account per rolling hour. Default 5. In production the value must be present in the process environment and at most 5, or the backend refuses to boot. |
| `SERVICE_TOKEN` | Optional token for `Authorization: Bearer ...` machine access. Must differ from `BETTER_AUTH_SECRET`. Empty disables Bearer auth. |
| `NVD_API_KEY` | Optional. Raises the NVD rate limit. |

### Frontend (`frontend/.env.local`)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Plain `postgresql://` URL for Better Auth. Must point at the same database as the backend. |
| `BETTER_AUTH_SECRET` | Same value as the backend. |
| `BETTER_AUTH_URL` | Origin Better Auth is served from, for example `http://localhost:3000`. |
| `NEXT_PUBLIC_APP_URL` | Public origin of the web app. |
| `NEXT_PUBLIC_API_URL` | Browser-facing API base. Locally `http://localhost:3000/api`, because the Next route handlers proxy to FastAPI. |
| `BACKEND_URL` | Server-side FastAPI origin, for example `http://localhost:8000`. |
| `SIGNUP_ENABLED` | Self-service sign-up gate. Unset means closed under `NODE_ENV=production` and open in development. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | Optional OAuth providers. Leave blank to hide those buttons. |
| `RESEND_API_KEY`, `AUTH_FROM_EMAIL` | Optional password reset. Without a key the flow answers identically but sends nothing. |

Optional sources (`OTX_API_KEY`, `URLSCAN_API_KEY`, `LEAKLOOKUP_API_KEY`) are documented in `backend/.env.example`. A blank value is a supported state: the source reports `not_configured` and the dashboard says why it is dark.

Secrets belong in environment variables only. Never commit a real `.env`, never log a key, and never expose one through a `NEXT_PUBLIC_*` variable.

### Default limits

| Limit | Default | Variable |
|---|---|---|
| Scans per account per hour | 5 | `RATE_LIMIT_PER_HOUR` |
| Analysis calls per account per hour | 20 | `FREE_RATE_LIMIT_PER_HOUR` |
| Guest scans per browser per day | 2 | `GUEST_SCAN_LIMIT_PER_DAY` |
| Guest scans per instance per day | 20 | `GUEST_SCAN_DAILY_TOTAL` |
| Scans per instance per day, all accounts | disabled (`0`) | `RATE_LIMIT_DAILY_TOTAL` |

## Usage

### In the browser

1. Sign in, or use the dashboard signed out for a guest scan.
2. Enter a public domain or IPv4 address. `localhost`, RFC1918 ranges and link-local addresses are refused on both the client and the server.
3. Read the report card by card. Every partial result is shown; a failed source is named with its reason.
4. Reopen past scans from the history card, or export the current report as JSON, Markdown or PDF.

### Through the API

The browser talks to the Next route handlers on port 3000, which forward to FastAPI using `BACKEND_URL`. The FastAPI routes are also reachable directly on port 8000. Two credentials are accepted by the backend:

- a Better Auth session cookie, sent by the web app, for account endpoints;
- `Authorization: Bearer <SERVICE_TOKEN>` for machine access, which requires `SERVICE_TOKEN` to be set.

The examples below use a POSIX shell.

```bash
curl -sS -X POST http://localhost:8000/api/v1/scan \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"target":"example.com"}'
```

```json
{"scan_id": "...", "status": "completed"}
```

Fetch the stored report with the returned id (`SCAN_ID` is the value from the response above):

```bash
curl -sS http://localhost:8000/api/v1/scan/SCAN_ID \
  -H "Authorization: Bearer $SERVICE_TOKEN"
```

`status` is one of `pending`, `running`, `completed`, `partial` or `failed`. `results` holds the per-source blocks and `errors` is a list of `{"source", "message"}` entries. Set `"force": true` in the request body to bypass the cache and fetch fresh data.

## API reference

All endpoints are under `/api/v1` unless noted. Interactive documentation is available at `/docs` in development only.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/health` | public | Liveness. No database or source checks. |
| `GET` | `/ready` | public | Readiness. Opens one database connection. |
| `GET` | `/health/sources` | account | Per-source availability, cached for `SOURCE_HEALTH_TTL_SECONDS`. |
| `POST` | `/api/v1/scan` | account or guest | Run a scan and store it. Returns `{scan_id, status}`. |
| `GET` | `/api/v1/scan/{scan_id}` | account or guest | Read one stored scan you own. |
| `GET` | `/api/v1/history` | account | Your scans, newest first. Supports `target`, `page` and `limit`. |
| `GET` | `/api/v1/target/{target}/trend` | account | Risk score over time for one target. |
| `POST` | `/api/v1/analysis/{dns,tls}` | account | DNS records, certificate chain and TLS details. Body: `{"target": "example.com"}`. |
| `POST` | `/api/v1/analysis/{headers,redirects,sitemap,contacts}` | account | Response headers, redirect chain, sitemap discovery, published contact details. Body: `{"url": "https://example.com"}`. |
| `POST` | `/api/v1/analysis/exif` | account | EXIF metadata from an image sent as base64 in `{"data": "..."}`. |
| `GET` | `/api/v1/analysis/phone/{number}` | account | Offline phone number format and country validation. |
| `GET` | `/api/v1/analysis/capabilities` | account | Which optional sources are configured. |

Analysis endpoints draw on `FREE_RATE_LIMIT_PER_HOUR` rather than the paid Shodan quota, accept `force` to bypass the cache, and return a policy failure as HTTP 200 with an `errors[]` entry. Only bad input is a 4xx.

## Project structure

```text
backend/
  app/
    core/        settings, auth guards, rate limits, TTL cache, logging, SSRF guard
    db/          async engine and session factory
    models/      SQLAlchemy models: target, scan, finding
    routers/     health, scan, history, analysis
    schemas/     Pydantic v2 request and response models
    services/    one module per source, plus orchestrator and risk scoring
  alembic/       schema migrations
  tests/         pytest suite
  Dockerfile     production image (installs pinned, hashed requirements)
frontend/
  app/           App Router pages, demo route and API proxy handlers
  components/    shared UI, including the shadcn primitives in components/ui
  lib/           API clients, validators, auth config, export builders
  public/evidence  screenshots referenced by the docs
```

Architecture, data model and design decisions are in [ARCHITECTURE.md](./ARCHITECTURE.md).

## Development

### Frontend

```bash
cd frontend
npm run lint      # ESLint, zero warnings allowed
npm run tsc       # TypeScript, no emit
npm test          # node --test over lib/*.test.ts
npm run build     # production build
npm run clean     # remove .next (fixes OneDrive EINVAL corruption)
```

### Backend

```bash
cd backend
pytest -q
ruff check .
black --check .
```

### Continuous integration

[`.github/workflows/ci.yml`](./.github/workflows/ci.yml) runs four jobs on every push and pull request:

- **backend:** migrations (`alembic upgrade head`, then `alembic check`), `pytest`, `ruff`, `black`, and `pip-audit` against the hashed requirement files.
- **prod-image-deps:** installs `requirements.txt` exactly as the container does and imports the whole app, so a runtime dependency missing from the production set cannot pass.
- **frontend:** `npm ci`, lint, type check, tests, `npm audit`, then `npm run build`.
- **secrets:** a range-limited `gitleaks` scan of the commits the push introduced.

## Deployment

The documented topology is Next.js on Vercel, FastAPI in a container, and managed PostgreSQL. The frontend needs no custom build settings ([`frontend/vercel.json`](frontend/vercel.json) only pins the framework); the backend image is [`backend/Dockerfile`](backend/Dockerfile), which runs `alembic upgrade head` before uvicorn and listens on port 7860 by default (overridden by `PORT`).

The ordered runbook, including the production-only requirements (`SIGNUP_ENABLED`, `RATE_LIMIT_PER_HOUR`, a pooled connection string for the frontend, and the driver-specific TLS parameters), is [WORKFLOW.md section 8](./WORKFLOW.md). Read it before deploying: several settings fail closed and a successful build is not proof that auth works.

## Contributing

Read [AGENTS.md](./AGENTS.md) first. It holds the non-negotiable rules: no secrets in the repo, no synchronous I/O in the async path, no new dependencies without approval, and a partial-failure test for any new source.

Before opening a pull request:

1. `npm run lint && npm run tsc && npm test` in `frontend/`.
2. `pytest -q && ruff check . && black --check .` in `backend/`.
3. No secrets in the diff.
4. Update [ARCHITECTURE.md](./ARCHITECTURE.md) if an API contract changed, and tick the matching item in [TODO.md](./TODO.md).

## Documentation

| File | Contents |
|---|---|
| [WORKFLOW.md](./WORKFLOW.md) | Setup details, environment reference, tests, troubleshooting, deployment runbook |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System design, data model, security model |
| [PRD.md](./PRD.md) | Product requirements and scope |
| [DESIGN.md](./DESIGN.md) | Visual language and copy rules |
| [AGENTS.md](./AGENTS.md) | Contribution rules for humans and AI agents |
| [CHANGELOG.md](./CHANGELOG.md) | What shipped, with the gates that were run |
| [TODO.md](./TODO.md) | Open work |

## License

[MIT](./LICENSE), copyright (c) 2026 bieruu.
