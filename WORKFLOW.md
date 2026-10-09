# WORKFLOW — Dev, Run, Ship

## 1. Prerequisites

- Node.js 22.18+, npm, Python 3.11+, and Docker with Compose. The floor is 22.18 rather than 20 because `npm test` runs `.ts` files directly through `node --test`, which needs Node's type stripping — unflagged from 22.18; on Node 20 every test file fails with `ERR_UNKNOWN_FILE_EXTENSION`.
- A Shodan API key for host lookups: https://account.shodan.io/
- On Shodan HTTP 403 or 404, the backend also checks Shodan's public keyless InternetDB for the resolved IP.
- Certificate Transparency lookup tries crt.sh, then the public Cert Spotter API, then optional Subfinder on the backend `PATH` (the backend Docker image bundles Subfinder v2.16.0)
- Optional Google/GitHub OAuth app credentials for social sign-in

## 2. First-time setup

Copy the environment examples and use the same PostgreSQL database for Better Auth and the backend. The frontend uses `postgresql://`; SQLAlchemy in the backend uses `postgresql+asyncpg://`.

```powershell
Copy-Item frontend\.env.local.example frontend\.env.local
Copy-Item backend\.env.example backend\.env
docker compose up -d postgres
```

`docker-compose.yml` has no default for `POSTGRES_PASSWORD` and fails fast without it, so set it in your shell (or a root `.env`) before `docker compose up`: `$env:POSTGRES_PASSWORD = "pick-any-local-password"`. The database user is `owner` and the database is `osint`; put the same password in both `DATABASE_URL` values.

Set the same random `BETTER_AUTH_SECRET` (at least 32 characters) in both env files. Never use the example placeholder in a running environment. Set `SHODAN_API_KEY` in `backend/.env`; add OAuth provider credentials only if using those providers.

Create Better Auth's user/session/account/verification tables once:

```powershell
cd frontend
npm install
npm run auth:migrate
```

Then initialize the application schema and run the backend:

```powershell
cd ..\backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements-dev.txt   # pinned + hashed; runtime-only → requirements.txt
alembic upgrade head
uvicorn app.main:app --reload --port 8000
```

`requirements.txt` (runtime) and `requirements-dev.txt` (runtime + test/lint tooling) are compiled from `requirements.in` / `requirements-dev.in` with hashes. After editing a `.in` file, recompile:

```powershell
uv pip compile --universal --python-version 3.11 --generate-hashes requirements.in -o requirements.txt
uv pip compile --universal --python-version 3.11 --generate-hashes requirements-dev.in -o requirements-dev.txt
```

FastAPI no longer creates or alters application tables during startup; schema changes are managed by Alembic before serving traffic. For a brand-new database, `alembic upgrade head` creates the application tables. If upgrading a database created by the previous `create_all` startup path, first verify that its `targets`, `scans`, and `findings` tables match the initial revision, then record that baseline once with `alembic stamp head`. Do not stamp an unknown or mismatched schema. Alembic intentionally ignores Better Auth-owned tables in the shared database.

In another terminal, start Next.js:

```powershell
cd frontend
npm run dev
```

For Bash, use `cp`, activate `.venv/bin/activate`, and use the same `npm` commands.

## 3. Environment reference

`frontend/.env.local`:

```dotenv
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_API_URL=http://localhost:3000/api
BETTER_AUTH_URL=http://localhost:3000
BETTER_AUTH_SECRET=<same-random-secret-as-backend>
DATABASE_URL=postgresql://osint:osint@localhost:5432/osint
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
BACKEND_URL=http://localhost:8000
# Sign-up admission control. Unset = closed when NODE_ENV=production, open in
# dev so the local signup flow works. Never put either in NEXT_PUBLIC_*.
SIGNUP_ENABLED=
# Optional allowlist: user@example.com, @example.com, *@example.com, or the bare
# example.com (whole domain). Empty = any email may register.
SIGNUP_EMAIL_ALLOWLIST=
```

`backend/.env`:

```dotenv
SHODAN_API_KEY=<key>
DATABASE_URL=postgresql+asyncpg://osint:osint@localhost:5432/osint
BETTER_AUTH_SECRET=<same-random-secret-as-frontend>
# Optional machine-to-machine token for Authorization: Bearer. Must differ from
# BETTER_AUTH_SECRET; leave empty to disable Bearer auth.
SERVICE_TOKEN=
CORS_ORIGINS=http://localhost:3000
APP_URL=http://localhost:3000
SQLITE_PATH=./data/cache.db
CACHE_BACKEND=sqlite
NVD_API_KEY=                # optional — raises NVD rate limits
SCAN_TIMEOUT_NVD=12
NVD_MAX_CPES=5
NVD_CVES_PER_CPE=20
NVD_PAGE_SIZE=100
RATE_LIMIT_PER_HOUR=5
# v2 analysis capabilities that cost no Shodan credit get their own quota, so a
# cheap endpoint can never exhaust a user's scan allowance. See backend/.env.example.
FREE_RATE_LIMIT_PER_HOUR=20
# Testing only — see §3.1.
RATE_LIMIT_EXEMPT_SUBJECTS=
# Optional v2 sources. All blank = supported; each reports `not_configured`.
LEAKLOOKUP_API_KEY=          # key required, free tier 10 queries/day, ToS-restricted
URLSCAN_API_KEY=             # optional; search works keyless at 30 req/min
VIRUSTOTAL_API_KEY=         # free key; needed for domain/IP/URL reputation
OTX_API_KEY=                # OPTIONAL — OTX works keyless at a lower rate limit
```

Generate a secret with `openssl rand -base64 32` or a trusted password generator. Do not commit real secrets or filled `.env` files.

### Optional v2 sources and what "off" looks like

None of these are boot blockers. A missing key means the source reports `status: "not_configured"` and the dashboard labels it as switched off — deliberately distinct from "found nothing", so an empty card is never ambiguous.

| Source | Key required? | What it costs | What it does NOT do |
|---|---|---|---|
| URLScan.io search | No (30 req/min/IP anonymous) | Free | Does not submit scans (that needs a key), and free-tier history is capped upstream at **30 days / 100 results per page** |
| Leak-Lookup | **Yes — key is free but required** | Free tier: 10 queries/day | Never emits emails or password hashes; ToS restricts queries to targets you are authorised to search |
| VirusTotal | Yes — free key | Free tier: low per-minute and per-day quota | Does not upload files on the free plan, and does not do deep/relationship analysis without a paid plan |
| AlienVault OTX | **No — works keyless** | Free; lower anonymous rate limit | A null `reputation` means *no data*, not zero — see ARCHITECTURE.md §4.3 |

See §8.5 for the sign-up bucket limitation that remains open.

### 3.1 Rate-limit exemption (testing only)

`RATE_LIMIT_EXEMPT_SUBJECTS` names subjects that skip **both** rate-limit buckets, so load/QA work is not stopped by our own 429 before it ever reaches the provider limits. Default empty: nobody is exempt.

```dotenv
# Requires SERVICE_TOKEN to be set — that is what proves the subject.
RATE_LIMIT_EXEMPT_SUBJECTS=user:service
SERVICE_TOKEN=<a long random secret, different from BETTER_AUTH_SECRET>
```

Call it with the bearer token, never from a browser:

```bash
curl -H "Authorization: Bearer $SERVICE_TOKEN" http://localhost:8000/api/v1/scan \
  -H 'content-type: application/json' -d '{"target":"example.com"}'
```

**Why this is safe.** `require_user()` returns exactly two shapes: `user:<db-id>` for a session cookie, and `user:service` only when the bearer token matches `SERVICE_TOKEN` under `hmac.compare_digest`. So exempting `user:service` exempts an identity that needs a secret which never reaches a browser. A stolen cookie or an XSS yields `user:<db-id>` and stays capped — the per-user quota exists precisely so one compromised account cannot become a cost vector on the paid Shodan key.

**What an exempt call does.** It is not merely uncapped: it creates no bucket, and it does **not** bill `RATE_LIMIT_DAILY_TOTAL`, so a load test cannot quietly drain the cost backstop and hand the next real user a 429. Every exempt call is logged at WARNING with the subject name, so a setting left on in production is visible in the logs.

**What it does NOT do.** It does not raise any *provider* limit. OTX (100 req/hour per IP) and Leak-Lookup (10 req/day per key) remain shared across every user of the deployment, because they are bounded by the backend's single egress IP and its single key. During heavy testing, expect those two to report `unavailable` with a rate-limit note — that is the provider answering, not this setting failing. For OTX, the fix is a free key from `otx.alienvault.com`, which raises or removes the anonymous ceiling.

### 4. Daily development

On Windows, `.\dev.ps1` starts the backend and frontend and opens `/sign-up`. The script does not create or bypass authentication sessions. The Better Auth schema migration in §2 must already have been run.

Create an account at `http://localhost:3000/sign-up`, then sign in at `/sign-in`. After sign-in, open `/dashboard` and scan a public domain such as `example.com`. Use the dashboard Log out control to revoke the session.

Browser API requests go through the Next proxy (`/api/scan/*`) to FastAPI. Do not call Shodan or CT services from the browser.

## 5. OAuth provider setup

OAuth is optional. In the provider console, set the callback URL to:

- Google: `http://localhost:3000/api/auth/callback/google`
- GitHub: `http://localhost:3000/api/auth/callback/github`

For production, replace the origin with the exact `BETTER_AUTH_URL`. Supply both the client ID and secret for each provider. A provider is not configured unless both are present. Live OAuth must be tested with valid provider credentials; a successful build is not proof of a live callback.

## 6. Tests and checks

```powershell
# Frontend
cd frontend
npm run lint
npm test
npm run tsc
npm run build
npm audit
npm audit --audit-level=high   # fail the build on high/critical

# Backend, from backend/ with its environment activated
alembic check
pytest -q
ruff check .
black --check .
```

> **CI required checks:** `.github/workflows/ci.yml` is tracked and runs on every `push` and `pull_request`. It defines two jobs — `backend` and `frontend` — and both must be green before merge (set them as required status checks in branch protection). What each job actually gates on:
>
> - `backend` — installs the hashed `backend/requirements-dev.txt` (a superset of `requirements.txt`: the test and lint tooling is not in the runtime file) against a `postgres:16` service, then runs Alembic `upgrade head` **and** `check` (so a model change without a migration fails CI), `pytest -q`, `ruff check .`, and `black --check .`.
> - `frontend` — `npm ci`, then `npm run lint`, `npm run tsc`, `npm test`, a dependency audit that fails on moderate-and-above findings, and `npm run build`.
> - Workflow-wide, and mandatory before merge: a Python dependency vulnerability scan (`pip-audit` against the pinned requirement files) and a secret scan over the diff, so a committed credential or a known-CVE Python dependency fails CI instead of reaching a deploy. If a future edit to `ci.yml` drops either one, treat it as a regression and restore it.
>
> `.github/workflows/ci.yml` is the source of truth for step names — update this list in the same PR whenever a gate changes. `npm run auth:migrate` is deliberately not a CI gate: the build does not need the Better Auth tables, and migrations run as part of the deploy runbook (§8.2).

Backend tests mock upstream OSINT services. For auth, tests verify active/expired/fake session behavior and owner isolation; run the §2 live PostgreSQL setup to validate signup and protected scans end to end.

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| Redirected to `/sign-in` | Sign in again; check `BETTER_AUTH_URL` matches the browser origin and the session has not expired. |
| Auth table missing | Run `npm run auth:migrate` from `frontend/` with a valid frontend `DATABASE_URL`. |
| Scan returns 401 | Confirm frontend and backend point to the same PostgreSQL DB and that the request includes the Better Auth cookie. |
| Scan returns 503 | Backend auth cannot use SQLite; configure its `DATABASE_URL` with the PostgreSQL `+asyncpg` URL for the shared session store. |
| OAuth provider unavailable | Configure both provider credentials and the correct callback URL, then restart/redeploy. |
| Backend unreachable (502) | Start FastAPI on port 8000 and check `BACKEND_URL`. |
| Private target rejected | Expected: localhost, RFC1918, link-local, and other restricted addresses are blocked. |
| OneDrive `EINVAL` under `.next` | `npm run clean`, then retry; `predev` and `prebuild` also clean the affected Next.js output. |

## 8. Deployment

Target topology: frontend on Vercel, FastAPI in a container (Fly — see §8.6; Render blueprint retained as the alternative), Postgres managed (Neon/Supabase).

`render.yaml` (repo root) is the Render blueprint for the backend only. It pins `rootDir: backend` (the Dockerfile lives there), `dockerfilePath: ./Dockerfile`, `healthCheckPath: /health`, one instance, and the region that should match the database. Every secret is `sync: false`, so applying the blueprint prompts for it and no credential is ever committed. The settings it encodes are the ones that are easy to get wrong by hand; anything not in it (the frontend, the database) is set in its own dashboard.

`frontend/vercel.json` is intentionally minimal: it pins `framework: "nextjs"` and adds `$schema` for editor validation, nothing else. Vercel already detects the build from `package.json` and `next.config.mjs`, so do not add build, output, or routing keys here without a concrete reason. Two deliberate omissions:

- **No `regions`.** Nothing in the repo fixes where Postgres or the backend container runs, so pinning a function region would be a guess. Keep Vercel's default and revisit once the database region is decided — ideally the functions run adjacent to the database.
- **No comments.** `vercel.json` is parsed as strict JSON by the Vercel CLI, so `//` comments make the file unparseable and break the deployment. This note lives here instead.

Production environment variables are set in the **Vercel project settings** (Settings → Environment Variables) — never in this file, never in `NEXT_PUBLIC_*`, never in git: `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET` (≥32 chars, identical to the backend value), `DATABASE_URL` (pooled Postgres endpoint, see §8.1), `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_API_URL`, `BACKEND_URL`, plus the sign-up gate `SIGNUP_ENABLED` / `SIGNUP_EMAIL_ALLOWLIST` (see §3 and §8.3). Apply the migrations in §8.2 before the deployment takes traffic.

### 8.3 Sign-up admission control (required in production)

Self-service sign-up is **closed by default when `NODE_ENV=production`** and the flag is unset. A deploy that forgets to opt in does not silently expose the Shodan-backed quota to the public internet, and an unparseable value is treated as unset — the same fail-closed direction as the rest of the production guards.

- `SIGNUP_ENABLED=true` reopens self-service sign-up. `SIGNUP_EMAIL_ALLOWLIST` narrows it further without touching code. The gate runs in `databaseHooks.user.create.before` (`lib/auth.ts`), which Better Auth invokes for **both** email/password sign-up and OAuth account creation — `disableSignUp` alone would only close the email endpoint and leave "Continue with Google" open. An explicit `false`/empty-string/unset is closed.
- This is an admission control, not a rate limit. Each legitimately created account still gets its own `RATE_LIMIT_PER_HOUR` scans against one paid Shodan key, so N accounts mean N × quota. Two bounds sit underneath it: the backend refuses to boot in production unless `RATE_LIMIT_PER_HOUR` is present in the **process environment** and at most 5 (§8.4), and `RATE_LIMIT_DAILY_TOTAL` caps admitted scans per instance per rolling 24h (disabled by default).
- `SIGNUP_EMAIL_ALLOWLIST` is also the practical lever for the Better Auth bucket problem in §8.5: if sign-up stays closed or allowlisted, the shared `/sign-up` rate-limit bucket cannot be reached by the public at all.
- Neither variable may be prefixed `NEXT_PUBLIC_*`: the client receives only a boolean saying whether the form is open, never the allowlist itself.

### 8.1 Connection pooler requirement (frontend auth)

`frontend/lib/auth.ts:42` connects with `new Pool({ connectionString: databaseUrl })` from `pg` — a direct TCP connection, not a pooler-aware client. Vercel functions are short-lived and scale horizontally, so each concurrent invocation can open its own connection, exhaust the database's connection slots, and make sign-in and session reads hang until they time out.

- The frontend's production `DATABASE_URL` must be a **pooled** endpoint: Supabase pooler, Neon pooled connection string, or a PgBouncer/Supavisor instance in front of Postgres. A direct connection is not acceptable here.
- Keep TLS on both connections. The production guard in `app/core/config.py` applies to the **backend's** URL only, and rejects a non-localhost Postgres URL carrying neither `sslmode=require` nor `ssl=require`. The frontend is not covered by that guard and needs a *different* spelling again, so do not copy one side's parameter to the other — see below.
- The backend talks to the same database through SQLAlchemy/asyncpg and should use the same pooled endpoint in production, bounded by its own pool size.
- `BETTER_AUTH_SECRET` must be the same value on both sides, and it must match what the migration in §8.2 step 3 ran against.

#### The TLS parameter is driver-specific, and the two spellings are mutually exclusive

Neither side accepts the other's spelling, and neither failure is obvious: the backend's passes the production guard and then crashes, while the frontend's fails certificate validation. Verified live against a Supabase project with the pinned drivers.

| Consumer | Driver | Correct | Wrong, and what it does |
|---|---|---|---|
| Backend (`app/db/session.py`) | asyncpg via SQLAlchemy | `?ssl=require` | `?sslmode=require` → `TypeError: connect() got an unexpected keyword argument 'sslmode'`. `app/core/config.py` accepts either in its guard, so it passes validation and dies at connect time. |
| Frontend (`lib/auth.ts`) | node-postgres | `?sslmode=no-verify` | `?sslmode=require` → `SELF_SIGNED_CERT_IN_CHAIN`, because the installed `pg-connection-string` treats `prefer`/`require`/`verify-ca` as aliases for `verify-full` and so does verify the chain. `?ssl=require` is worse: `pg` throws `Cannot use 'in' operator to search for 'key' in require` while upgrading the socket. |
| Postgres cache path (`app/core/cache.py`) | asyncpg, direct | `ssl` as a keyword | `ssl` left in the DSN → `CantChangeRuntimeParamError: parameter "ssl" cannot be changed now`, because asyncpg parses DSN query parameters as *server settings*, not connection options. Fixed in this repo; see the changelog. |

- **One connection string cannot serve both sides.** The frontend and backend need different endpoints anyway (pooled vs direct, §8.1 below), and each of those URLs has exactly one correct TLS spelling. Copying a working URL from one side to the other breaks it.
- **`no-verify` costs something real.** The frontend hop is encrypted but the server certificate is not authenticated, so there is no protection against an active man-in-the-middle. Doing it properly means passing Supabase's CA bundle as `sslrootcert` to a path that also exists inside the deployed Vercel function; open work in TODO.md. Until it lands, "TLS is verified" is a false claim about this deployment.
- **`uselibpqcompat=true&sslmode=require`** is the third option and behaves like `no-verify` (libpq semantics, no chain check). It is worse to read and buys nothing here.

#### Supabase specifics

- **Two endpoints, one database.** The backend reads the Better Auth `session` table directly (`app/core/security.py`), so both apps must point at the *same* project; a separate database for the frontend would 401 every scan.
- **Frontend → pooled.** Use the Supavisor connection string on port **5432** (session mode), user `postgres.<project-ref>`, host `aws-0-<region>.pooler.supabase.com`, with `?sslmode=no-verify` — see the note above for why `require` fails here.
- **Backend → direct.** `db.<project-ref>.supabase.co:5432` with `?ssl=require`. One long-lived container does not need a pooler, and it avoids spending the pooler's connection budget. Running Alembic against the pooler also works, but the direct URL is what the runbook asks for, so use it and keep one variable per deployment.
- **Region alignment is partial by platform.** Render offers Oregon, Ohio, Virginia, Frankfurt and Singapore — there is no Tokyo region — so a Supabase project in `ap-northeast-1` can only ever be paired with a Render service in another continent or Singapore. Same-region is worth recreating a not-yet-deployed project for; once data exists, a cross-region hop on every query is the cheaper mistake to keep.
- URL-encode the database password if it contains `@ : / # ?`.
- **Free plan pauses.** A project with low activity over 7 days is paused automatically and restored from the dashboard (1-year window). A paused database fails both migrations and every request, so a demo deployment needs either occasional traffic or a paid plan.
- **Free plan connections.** Budget them: the SQLAlchemy engine pool, Alembic's migration connection, the Postgres cache path (which opens a connection per call rather than using the pool), and the frontend's pool. Keep `CACHE_BACKEND=sqlite` if the backend is later given a persistent volume, or lower `pool_size` before raising the plan.

### 8.2 Deploy runbook (ordered — do not skip or reorder)

1. **Confirm the database and its pooled URL.** Create the database if it does not exist, and keep the pooled connection string from §8.1 handy for both apps.
2. **Backend schema first — from `backend/`:** `alembic upgrade head`. For an existing database created by the old startup `create_all`, verify that its `targets`, `scans`, and `findings` tables match the initial revision before the one-time `alembic stamp head`; never stamp a schema you have not checked.
3. **Frontend auth schema — from `frontend/`:** `npm run auth:migrate`. This script reads `DATABASE_URL` from `frontend/.env.local`, so point it at the pooled production database before running it; do not run it inside the Vercel build. It passes `--yes`, which is what makes it usable in a scripted deploy: the CLI otherwise asks `Are you sure you want to run these migrations? (y/N)`, and with no interactive terminal the answer is **no** — the command then exits **0** having created nothing, which reads as success. Confirm the four tables exist (`user`, `session`, `account`, `verification`) rather than trusting the exit code. On Windows PowerShell, a shell variable takes precedence over `--env-file`, so `$env:DATABASE_URL = "…"; npm run auth:migrate` overrides the file for that command without editing it.
4. **Only then set the production origin variables**, once the domain is final:
   - Frontend (Vercel project env): `BETTER_AUTH_URL=https://<prod-domain>`, `NEXT_PUBLIC_APP_URL=https://<prod-domain>`, plus `BETTER_AUTH_SECRET`, the pooled `DATABASE_URL`, and `BACKEND_URL=https://<backend-host>`. Set `SIGNUP_ENABLED` (and `SIGNUP_EMAIL_ALLOWLIST` if sign-up should be restricted) — see §8.3. It is **required** for step 6: self-service sign-up is closed by default under `NODE_ENV=production`, so step 6 fails at the sign-up step until the flag is set.
   - Backend (container env): `CORS_ORIGINS=https://<prod-domain>` (exact origin, no trailing slash, no wildcard), `APP_URL=https://<prod-domain>`, plus the same secret and the same database. `RATE_LIMIT_PER_HOUR` is **required** and the backend refuses to boot without it — see §8.4. Set it as a real container/host environment variable, not only a `.env` file inside the image.
5. **Deploy the backend container first** and confirm it responds, then deploy the frontend to Vercel. Any release that changes a schema repeats steps 2 and 3 before it takes traffic.
6. **Verify end to end on the production domain:** sign up, run a scan against a public domain, sign out. A successful build is not proof that auth works in production.

### 8.6 Backend host: Fly.io (`backend/fly.toml`)

`render.yaml` at the repo root stays valid and remains the alternative for anyone with a payment method Render accepts. The **active** target is Fly, because Render's signup demands credit-card verification and the operator's card is declined — and of the no-card-free alternatives, none of them can host this backend (Vercel and Cloudflare Workers have no raw TCP sockets, which `tls_service` needs).

**Deploy from inside `backend/`, not from the repo root.** Fly's `[build] dockerfile` does not change the Docker build context — the context is the directory the deploy runs from — and the Dockerfile copies `requirements.txt`, `alembic.ini` and `alembic/`, which exist only under `backend/`. A deploy from the root fails with `COPY failed: file not found in build context`.

```powershell
# 1. create the app once; flyctl needs no card for this, which is the point
cd backend
fly launch --no-deploy --copy-config=false --name osint-api --region nrt
fly apps list                 # confirm osint-api exists

# 2. secrets -- never in fly.toml, never in git
fly secrets set DATABASE_URL="postgresql+asyncpg://postgres:PASSWORD@db.<REF>.supabase.co:5432/postgres?ssl=require"
fly secrets set BETTER_AUTH_SECRET="<same 43-char value as frontend/.env.local>"
fly secrets set SHODAN_API_KEY="<key, or omit to keep the Shodan source dark>"
fly secrets set CORS_ORIGINS="https://<vercel-domain>"
fly secrets set APP_URL="https://<vercel-domain>"

# 3. deploy (the Dockerfile CMD runs `alembic upgrade head` before uvicorn)
fly deploy
fly status
fly logs --tail              # expect: alembic upgrade head OK, then "ready" on /ready
```

- **`?ssl=require`, not `sslmode=require`,** for the backend URL — the same driver rule as §8.1, and `config.py`'s guard accepts either spelling, so the wrong one only fails at connect time.
- **`BETTER_AUTH_SECRET` must equal the frontend's.** Two different values mean every scan 401s.
- **Cost:** `shared-cpu-1x` / 512 MB is the smallest always-on size Fly offers. It has no free allowance, so a deployed app bills continuously. `auto_stop_machines = "off"` is deliberate — a stopped Machine is still billed for its root filesystem, so stopping saves almost nothing while making every quiet period pay a cold start inside the 60s Vercel budget (see the cold-backend note in §8.2). Free to *try*: Fly's trial needs no credit card, so the deploy can be proven before any payment method exists.
- **One Machine only.** The rate limiter is per-process, so a second Machine would multiply every quota (`RATE_LIMIT_PER_HOUR`). Scale with `fly machine run` deliberately, never by autoscale.
- **Health check is `/health`, not `/ready`** — `/ready` opens a database connection on every probe. `grace_period` is 30s because the CMD migrates before it serves.

Other deployment notes:

- Backend: `APP_ENV=production`, `SHODAN_API_KEY`, and `CACHE_BACKEND=postgres` on hosts without a persistent volume (see ARCHITECTURE.md §7). The rate limiter is per-process, so run a single uvicorn worker in production.
- On non-container hosts, install Subfinder separately and make it available on the backend `PATH` to enable the final bounded certificate-transparency fallback. The backend Docker image builds and includes Subfinder v2.16.0.
- If crt.sh is unavailable, the backend tries Cert Spotter before Subfinder. A successful fallback is shown as the provider for the certificate-transparency results and cached. Cert Spotter's anonymous free tier limits full-domain queries to 10 per hour; a source error is reported only if every passive fallback fails.
- Configure OAuth callback URLs for the deployed origin. Do not advertise or mark a provider verified until a live callback succeeds.
- Rotate secrets through the relevant provider/host dashboards; never place secrets in client-prefixed variables or source control.

**A cold backend is a 504, not a slow scan.** The proxy routes (`app/api/scan`, `app/api/analysis`, `app/api/history`, `app/api/trend`) hold one request open for as long as the backend takes, and they declare no `maxDuration`, so they inherit Vercel's Hobby ceiling of 60s. A scan itself fits — the orchestrator gathers its sources concurrently, so wall-clock tracks the slowest per-source timeout (`SCAN_TIMEOUT_CRTSH`, 30s by default) rather than their sum — but a backend that is asleep when the request lands spends its wake-up time inside that same 60s budget. On a free host that sleeps on idle, the first scan after a quiet period can therefore time out at the edge while the backend is still booting. Practical mitigations, cheapest first: hit the backend URL directly once to warm it, then scan; treat a first-scan 504 as "retry in a minute" rather than as a broken deploy. Declaring `maxDuration` and surfacing a real error would make the failure legible instead of a bare edge timeout — that is open work, tracked in TODO.md.

### 8.4 Scan quota (required in production)

`Settings.model_post_init` fails closed, in the same shape as the `BETTER_AUTH_SECRET`, `CORS_ORIGINS`, and `sslmode=require` guards: under `APP_ENV=production` or `NODE_ENV=production` the backend **refuses to boot** unless `RATE_LIMIT_PER_HOUR` is present in the process environment, parses as a whole number, is at least 1, and is at most `PRODUCTION_RATE_LIMIT_CEILING` (5). Each failure names the variable in the error.

- **It must be a real environment variable**, not only a `backend/.env` file baked into the image. Pydantic reads the field either way, but the production guard checks `os.getenv` so that "unset" is distinguishable from "deliberately 5" — an unset quota on a paid Shodan key is a silent budget decision. On compose that means the `environment:` block, not just `env_file`.
- **5 is the ceiling, not a suggestion.** At 5 scans/hour one account draws at most ~3.6k Shodan queries per 30-day month, inside the monthly allowance of an entry paid plan. At the old default of 10 an account could draw ~7.2k/month on its own, and that scales with the number of accounts. To serve more traffic, buy more Shodan credit rather than raising the constant — it lives in code so the increase is a reviewable diff.
- **`RATE_LIMIT_DAILY_TOTAL`** (default `0`, disabled) is an opt-in instance-wide ceiling on *admitted* scans per rolling 24h, counted in hourly buckets so the counter stays bounded. Refused requests never spend budget. It exists because the per-account quota cannot express "this one shared key must not spend more than X per day".
- **`RATE_LIMIT_MAX_KEYS`** (default `10000`) caps live bucket keys. At the cap an unknown key is refused with 429 until the next sweep, fail closed — no eviction, so no already-limited account regains quota.
- All three counters are per-process. Single worker in production, or every bound above multiplies by worker count (see ARCHITECTURE.md §6).

### 8.5 Better Auth sign-up bucket (known limitation)

Verified against the installed `better-auth@1.7.7` and pinned by `frontend/lib/auth-rate-limit.test.ts`. Better Auth rate-limits `/sign-up*` at 3 requests / 10 seconds, and the bucket key is `` `${ip}|${path}` ``. `getIPFromHeader` returns `null` when `x-forwarded-for` holds more than one hop and no `trustedProxies` are configured, and in production there is no localhost fallback — `null` becomes the literal key `no-trusted-ip`. Every sign-up therefore shares **one** bucket.

The effect is bidirectional: abuse self-limits, and one attacker can exhaust everyone's sign-up quota (user-DoS).

- `BETTER_AUTH_TRUSTED_PROXIES` (comma-separated CIDR, **empty by default**) fixes it, but only if you know the address of the hop nearest your app. The parser here is stricter than Better Auth's on purpose: `0.0.0.0/0`, `::/0`, and bare `0.0.0.0` are rejected, because they make the limiter trust the client-supplied leftmost token and match every address — the limiter stops limiting.
- **On Vercel this knob will typically stay empty**, because Vercel does not publish edge ingress ranges, so the shared bucket persists there. Header reordering does not help: Vercel documents `x-real-ip` as identical to `x-forwarded-for`. `rateLimit.customRules` cannot help either — the key is computed before rules are resolved, and a rule can only narrow or widen.
- The real mitigation on Vercel is §8.3: keep sign-up closed or allowlisted, so the shared bucket is not reachable by the public. Closing this properly needs a limiter outside Better Auth (v2).
