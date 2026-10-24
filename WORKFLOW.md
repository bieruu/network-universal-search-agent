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
DATABASE_URL=postgresql://owner:<same-password-as-backend>@localhost:5432/osint
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
# Optional reverse-proxy CIDRs that append to x-forwarded-for. Empty by default;
# see §8.5 for why max-sign-up buckets stay shared when this is unset.
BETTER_AUTH_TRUSTED_PROXIES=
# Password reset (forgot-password -> reset-password). All optional; with no
# RESEND_API_KEY the app boots and the flow still answers identically for every
# address, it just cannot send anything (one operator warning per process).
# RESEND_API_KEY is a SECRET — env only, never NEXT_PUBLIC_*, never committed.
RESEND_API_KEY=
AUTH_FROM_EMAIL=NUSA project <noreply@your-domain.com>
RESET_EMAIL_TIMEOUT_MS=10000
```

`frontend/.env.local.example` is the source of truth for this block; the example file ships the same names with `owner` as the database user.

`backend/.env`:

```dotenv
SHODAN_API_KEY=<key>
# POSTGRES_* are read by docker-compose.yml, not by the app.
POSTGRES_DB=osint
POSTGRES_USER=owner
POSTGRES_PASSWORD=<pick-any-local-password>
DATABASE_URL=postgresql+asyncpg://owner:<same-password>@localhost:5432/osint
BETTER_AUTH_SECRET=<same-random-secret-as-frontend>
# Optional machine-to-machine token for Authorization: Bearer. Must differ from
# BETTER_AUTH_SECRET; leave empty to disable Bearer auth.
SERVICE_TOKEN=
CORS_ORIGINS=http://localhost:3000
APP_URL=http://localhost:3000
SQLITE_PATH=./data/cache.db
CACHE_BACKEND=sqlite            # sqlite | postgres
SCAN_TIMEOUT_SHODAN=12
SCAN_TIMEOUT_CRTSH=15           # code default is 30; the shipped .env lowers it
SCAN_TIMEOUT_WHOIS=10
SCAN_TIMEOUT_DNS=10
SCAN_TIMEOUT_NVD=12
SOURCE_HEALTH_TTL_SECONDS=300   # GET /health/sources probe cache
NVD_API_KEY=                # optional — raises NVD rate limits
NVD_MAX_CPES=5
NVD_CVES_PER_CPE=20
NVD_PAGE_SIZE=100
RATE_LIMIT_PER_HOUR=5
RATE_LIMIT_DAILY_TOTAL=0        # 0 = disabled; instance-wide admitted-scan backstop
RATE_LIMIT_MAX_KEYS=10000
# v2 analysis capabilities that cost no Shodan credit get their own quota, so a
# cheap endpoint can never exhaust a user's scan allowance. See backend/.env.example.
FREE_RATE_LIMIT_PER_HOUR=20
# Guest (signed-out) scans — dashboard only, reversal 2026-10-14 (DESIGN.md).
GUEST_SCAN_LIMIT_PER_DAY=2
GUEST_SCAN_DAILY_TOTAL=20
# Testing only — see §3.1.
RATE_LIMIT_EXEMPT_SUBJECTS=
# Optional v2 sources. All blank = supported; each reports `not_configured`.
LEAKLOOKUP_API_KEY=          # key required, free tier 10 queries/day, ToS-restricted
URLSCAN_API_KEY=             # optional; search works keyless at 30 req/min
VIRUSTOTAL_API_KEY=          # BYOK only: no service reads this today, it just flips /capabilities
OTX_API_KEY=                 # OPTIONAL — OTX works keyless at a lower rate limit
```

Generate a secret with `openssl rand -base64 32` or a trusted password generator. Do not commit real secrets or filled `.env` files.

### Optional v2 sources and what "off" looks like

None of these are boot blockers. A missing key means the source reports `status: "not_configured"` and the dashboard labels it as switched off — deliberately distinct from "found nothing", so an empty card is never ambiguous.

| Source | Key required? | What it costs | What it does NOT do |
|---|---|---|---|
| URLScan.io search | No (30 req/min/IP anonymous) | Free | Does not submit scans (that needs a key), and free-tier history is capped upstream at **30 days / 100 results per page** |
| Leak-Lookup | **Yes — key is free but required** | Free tier: 10 queries/day | Never emits emails or password hashes; ToS restricts queries to targets you are authorised to search |
| VirusTotal | Key accepted but **queries no source** | N/A today | **Not integrated** (licensing, ARCHITECTURE.md §4.3). `VIRUSTOTAL_API_KEY` only flips the `virustotal` entry in `GET /api/v1/analysis/capabilities`; no scan or analysis block is fetched from VT. *(Corrected 2026-10-25: this row previously described a working VT source and its free-tier limits. The key is read by `routers/analysis.py` for that one flag — no service module consumes it, which is what "queries no source" means here.)* |
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

Password reset lives at `/forgot-password` and `/reset-password`. Without `RESEND_API_KEY` both pages still work end to end and the server logs one warning saying no email is sent — the flow cannot actually deliver a link until the key is set (see the env block in §3).

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

> **CI required checks:** `.github/workflows/ci.yml` is tracked and runs on every `push` and `pull_request`. It defines four jobs — `backend`, `prod-image-deps`, `frontend` and `secrets` — and all of them must be green before merge (set them as required status checks in branch protection). What each job actually gates on:
>
> - `backend` — installs the hashed `backend/requirements-dev.txt` (a superset of `requirements.txt`: the test and lint tooling is not in the runtime file) against a `postgres:16` service, then runs Alembic `upgrade head` **and** `check` (so a model change without a migration fails CI), `pytest -q`, `ruff check .`, and `black --check .`.
> - `prod-image-deps` — installs `backend/requirements.txt` **with `--require-hashes` into a clean venv, the same flags the Dockerfile uses**, then imports `app.main`, which builds the app and pulls in every router and service. It exists because the two files above disagree silently: `requirements-dev.txt` is a superset of `requirements.in`, so a runtime package that is only in `requirements.in` and missing from `requirements.txt` passes the entire backend job and then crash-loops the container at boot. That is not hypothetical — dnspython, pillow, phonenumbers and cryptography were all missing from the runtime file this way and only a local image build caught it.
> - `frontend` — `npm ci`, then `npm run lint`, `npm run tsc`, `npm test`, a dependency audit that fails on moderate-and-above findings, and `npm run build`.
> - `secrets` — a secret scan over the pushed commit range, with redacted output.
> - Workflow-wide, and mandatory before merge: a Python dependency vulnerability scan (`pip-audit` against the pinned requirement files), so a known-CVE Python dependency fails CI instead of reaching a deploy. *(2026-10-25: it is a step inside the `backend` job — "Audit backend dependencies", `ci.yml` lines ~64-74 — not a fifth job; the sentence above keeps its meaning because that job is a required check.)* If a future edit to `ci.yml` drops either one, treat it as a regression and restore it.
>
> `.github/workflows/ci.yml` is the source of truth for step names — update this list in the same PR whenever a gate changes. `npm run auth:migrate` is deliberately not a CI gate: the build does not need the Better Auth tables, and migrations run as part of the deploy runbook (§8.2).
>
> **Keeping `requirements.txt` in sync with `requirements.in`.** The runtime file is `uv pip compile` output and does not update itself. After editing `backend/requirements.in`, regenerate from `backend/` with the same constraint that keeps shared pins identical between the runtime file and CI:
>
> ```powershell
> uv pip compile --universal --python-version 3.11 --generate-hashes -c requirements-dev.txt requirements.in -o requirements.txt
> ```
>
> The `-c` constraint is the point: without it the compile resolves every shared dependency against today's index and quietly moves pins that CI and the venv were verified against. `prod-image-deps` catches a skipped regeneration, but the constraint keeps what ships the same as what was tested.

Backend tests mock upstream OSINT services. For auth, tests verify active/expired/fake session behavior and owner isolation; run the §2 live PostgreSQL setup to validate signup and protected scans end to end.

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| Redirected to `/sign-in` *(superseded 2026-10-14)* | No page redirects there any more: `middleware.ts` is CSP-only and the dashboard renders in guest mode. Sign in is a choice — the links are on the guest banner and the locked History/trend cards. *(Kept because it was the pre-reversal behaviour; see ARCHITECTURE.md §6.)* |
| Guest scan returns 401 | Guest scanning is closed: `GUEST_SCAN_LIMIT_PER_DAY=0` on the backend, or no `X-Guest-Token`/`nusa_guest` cookie reached FastAPI. Check the Next proxy and that both sides share `BETTER_AUTH_SECRET`. |
| Guest scan returns 429 | The daily guest quota is spent (`GUEST_SCAN_LIMIT_PER_DAY`, or the instance-wide `GUEST_SCAN_DAILY_TOTAL`). Sign in for the account quota. |
| Auth table missing | Run `npm run auth:migrate` from `frontend/` with a valid frontend `DATABASE_URL`. |
| Scan returns 401 | Confirm frontend and backend point to the same PostgreSQL DB and that the request includes the Better Auth cookie. |
| Scan returns 503 | Backend auth cannot use SQLite; configure its `DATABASE_URL` with the PostgreSQL `+asyncpg` URL for the shared session store. |
| OAuth provider unavailable | Configure both provider credentials and the correct callback URL, then restart/redeploy. |
| Backend unreachable (502) | Start FastAPI on port 8000 and check `BACKEND_URL`. |
| Private target rejected | Expected: localhost, RFC1918, link-local, and other restricted addresses are blocked. |
| OneDrive `EINVAL` under `.next` | `npm run clean`, then retry; `predev` and `prebuild` also clean the affected Next.js output. |
| `/` returns 500 mid-session with `SyntaxError: Unexpected end of JSON input`, `PageNotFoundError` for a route that does exist, `Failed to generate static paths … Cannot read properties of undefined (reading 'call')`, or `Caching failed for pack … rename *.pack.gz_` | The same OneDrive `.next` corruption, just during HMR instead of at boot — the landing parses no JSON at all, so do not chase application code for this. `npm run clean`, then `npm run dev` (its `predev` cleans anyway) and the page is 200 on the next request. Observed 2026-10-14: two `GET / 500` during a Fast Refresh full reload, 200 again immediately after, with the `rename` ENOENT on `1.pack.gz` in the same log. |

## 8. Deployment

Target topology: frontend on Vercel, FastAPI in a container on a Hugging Face Docker Space (see §8.6), Postgres managed (Neon/Supabase).

Backend deploys push the `backend/` subtree to the Space repository: `git remote add hf https://huggingface.co/spaces/<user>/<space>` once, then `git subtree push --prefix=backend hf main` for every deploy (§8.6). Secrets and non-secret config go in the Space's **Settings → Variables and secrets**, because the Space repo root *is* `backend/` and the monorepo root cannot be pushed to it. `deploy-koyeb.ps1` (repo root) is retained for the Koyeb path — the same runbook wrapped for that host, which is now an alternative rather than the active target. Anything outside the container — the frontend, the database — is configured in its own dashboard.

`frontend/vercel.json` is intentionally minimal: it pins `framework: "nextjs"` and adds `$schema` for editor validation, nothing else. Vercel already detects the build from `package.json` and `next.config.mjs`, so do not add build, output, or routing keys here without a concrete reason. Two deliberate omissions:

- **No `regions`.** Nothing in the repo fixes where Postgres or the backend container runs, so pinning a function region would be a guess. Keep Vercel's default and revisit once the database region is decided — ideally the functions run adjacent to the database.
- **No comments.** `vercel.json` is parsed as strict JSON by the Vercel CLI, so `//` comments make the file unparseable and break the deployment. This note lives here instead.

Production environment variables are set in the **Vercel project settings** (Settings → Environment Variables) — never in this file, never in `NEXT_PUBLIC_*`, never in git: `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET` (≥32 chars, identical to the backend value), `DATABASE_URL` (pooled Postgres endpoint, see §8.1), `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_API_URL`, `BACKEND_URL`, plus the sign-up gate `SIGNUP_ENABLED` / `SIGNUP_EMAIL_ALLOWLIST` (see §3 and §8.3), plus `RESEND_API_KEY` / `AUTH_FROM_EMAIL` for password reset (see the env block in §3 — password reset is OFF until `RESEND_API_KEY` is set). Apply the migrations in §8.2 before the deployment takes traffic.

### 8.3 Sign-up admission control (required in production)

Self-service sign-up is **closed by default when `NODE_ENV=production`** and the flag is unset. A deploy that forgets to opt in does not silently expose the Shodan-backed quota to the public internet, and an unparseable value is treated as unset — the same fail-closed direction as the rest of the production guards.

- `SIGNUP_ENABLED=true` reopens self-service sign-up. `SIGNUP_EMAIL_ALLOWLIST` narrows it further without touching code. The gate runs in `databaseHooks.user.create.before` (`lib/auth.ts`), which Better Auth invokes for **both** email/password sign-up and OAuth account creation — `disableSignUp` alone would only close the email endpoint and leave "Continue with Google" open. An explicit `false`/empty-string/unset is closed.
- This is an admission control, not a rate limit. Each legitimately created account still gets its own `RATE_LIMIT_PER_HOUR` scans against one paid Shodan key, so N accounts mean N × quota. Two bounds sit underneath it: the backend refuses to boot in production unless `RATE_LIMIT_PER_HOUR` is present in the **process environment** and at most 5 (§8.4), and `RATE_LIMIT_DAILY_TOTAL` caps admitted scans per instance per rolling 24h (disabled by default).
- `SIGNUP_EMAIL_ALLOWLIST` is also the practical lever for the Better Auth bucket problem in §8.5: if sign-up stays closed or allowlisted, the shared `/sign-up` rate-limit bucket cannot be reached by the public at all.
- Neither variable may be prefixed `NEXT_PUBLIC_*`: the client receives only a boolean saying whether the form is open, never the allowlist itself.

### 8.1 Connection pooler requirement (frontend auth)

`frontend/lib/auth.ts` opens the auth database with `new Pool({ connectionString: databaseUrl })` from `pg` (currently line 101) — a direct TCP connection, not a pooler-aware client. Vercel functions are short-lived and scale horizontally, so each concurrent invocation can open its own connection, exhaust the database's connection slots, and make sign-in and session reads hang until they time out.

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
- **Backend → direct.** `db.<project-ref>.supabase.co:5432` with `?ssl=require`. One long-lived container does not need a pooler, and it avoids spending the pooler's connection budget. Running Alembic against the pooler also works, but the direct URL is what the runbook asks for, so use it and keep one variable per deployment. One caveat rides on it: the direct hostname may resolve to IPv6 only, and a container without IPv6 egress then fails to connect while still looking healthy — §8.6 has the signal and the pooler-session fallback.
- **Region alignment is partial by platform, and impossible on the free tier.** The Supabase project is in `ap-northeast-1` (Tokyo). The backend host offers no region choice at the free tier — a Hugging Face CPU Basic Space is 2 vCPU / 16 GB RAM with ~50 GB of **non-persistent** disk, which resets on restart, and that is why `CACHE_BACKEND=postgres` (§8.6). The earlier candidates were no better: Koyeb's `free` Instance was offered in Frankfurt and Washington DC only (Tokyo needs a paid Instance type), and Render never offered Tokyo at all (Oregon, Ohio, Virginia, Frankfurt, Singapore). So this deployment pays a cross-region hop on every query and there is nothing to configure about it; moving the database next to the host is the fix, not a region setting.
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

### 8.6 Backend host: Hugging Face Docker Space

#### Why the switch

Render and Fly were the earlier candidates and neither produced a running service: Render's signup demands credit-card verification and the operator's card is declined, and Fly has no free compute tier, so a deployed app bills continuously. Koyeb covered that gap until its own signup demanded a card (a $29 pre-authorization hold), which is the same decision as Render's. Hugging Face Spaces is the host now, chosen for its **Docker** SDK specifically: this image is multi-stage, compiles Subfinder with Go, and is started by a command that runs Alembic before uvicorn — none of which a Gradio or Stream Space can do. Vercel and Cloudflare Workers remain ruled out structurally for the same reason as before: `tls_service` needs raw TCP sockets, which neither has. **Free-tier status for Docker Spaces is unverified:** third-party sources describe the free hardware tiers and their limits inconsistently, and the question cannot be settled from here. Confirm what the hardware picker offers at Space creation before treating this deployment as no-cost, and read the tier's published numbers as claims rather than facts.

#### Port 7860, and why anything else is unreachable

Hugging Face Docker Spaces route HTTP to container port **7860** and do **not** set `$PORT` (Koyeb did). That makes the port a hard requirement rather than a convention: a container listening on 8000 builds fine, boots fine, and serves nothing, because the platform sends its traffic to 7860 and nothing there answers. `backend/Dockerfile` `EXPOSE`s 7860 and its `CMD` ends in `uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-7860}` — the default suits the Space, and `$PORT` still wins when it is set, so `docker run -e PORT=8000` keeps working locally. `EXPOSE` is documentation only; what lands traffic is uvicorn listening on 7860.

`backend/README.md` has to carry the `sdk: docker` + `app_port: 7860` YAML front matter, because the Space repository root *is* the `backend/` subtree (below). Without that front matter nothing declares the SDK, and without `app_port` matching the container HTTP has nowhere to land.

#### Deploy mechanics: push the `backend/` subtree

The Space repo root must be the directory that holds the Dockerfile — `backend/` — while this repository's root holds the whole monorepo. `git subtree push --prefix=backend` is what maps one onto the other: it rewrites the commits touching `backend/` into a standalone history whose root is `backend/`, and pushes that history to the Space. Pushing the monorepo root is not an option — there is no Dockerfile at the top level, and unlike Koyeb there is no subdirectory build-context flag to point at.

```powershell
git remote add hf https://huggingface.co/spaces/<user>/<space-name>
git subtree push --prefix=backend hf main
```

Git authentication is the Space's own credentials: a token from `huggingface.co/settings/tokens` with the **write** role used as the password, or `hf auth login` from the `huggingface_hub` package. Remote URLs are not secrets and can be committed; tokens never are. Every deploy is those two commands, and each push rebuilds the image from the Dockerfile inside the subtree.

#### What the Space is configured with, and why each one matters

Everything below is injected as a real environment variable at container start, so there is no `.env` inside the image and nothing to keep in sync by hand. Secrets go under **Settings → Variables and secrets** as secrets (encrypted, and never shown again after saving); plain variables are for non-sensitive settings only. Saving any of them restarts the Space, which is also how a stale value gets replaced.

**SECRETS**

| Setting | Value | Reason |
|---|---|---|
| `DATABASE_URL` | `postgresql+asyncpg://postgres:PASSWORD@db.<REF>.supabase.co:5432/postgres?ssl=require` | The shared session/database URL — the backend reads Better Auth's `session` table directly (§8.1). asyncpg rejects `sslmode=` as a keyword, so `?ssl=require` is the only correct spelling: `config.py`'s guard accepts either, which means the wrong one validates and then dies at connect time, after a several-minute build. |
| `BETTER_AUTH_SECRET` | the same value as the frontend's | Two different values mean every scan 401s. |
| `APP_URL` | `https://<vercel-domain>` | The origin the backend names in what it emits; must be the exact browser origin. |
| `CORS_ORIGINS` | `https://<vercel-domain>` | Exact origin, no trailing slash, no wildcard — `config.py` refuses to boot in production on a wildcard, and a trailing slash fails every browser preflight for a reason that is invisible server-side. |
| `SHODAN_API_KEY`, `NVD_API_KEY`, `OTX_API_KEY`, `URLSCAN_API_KEY`, `VIRUSTOTAL_API_KEY`, `LEAKLOOKUP_API_KEY` | optional | Forward each only when the value is real, so production reports the same source coverage as a local scan. A placeholder (`your-key`, `changeme`, a value ending in `-key`) is worse than an omission: the source looks configured and then throws on every call, which reads as an outage, while an unset source reports `not_configured`, which reads as the decision it actually is. `SERVICE_TOKEN` and `RATE_LIMIT_EXEMPT_SUBJECTS` are deliberately **not** forwarded — they are QA load-testing controls that grant unlimited quota (§3.1), and an empty `SERVICE_TOKEN` fails closed, so not sending them leaves the public deployment without an exemption. |

**PLAIN VARIABLES**

| Setting | Value | Reason |
|---|---|---|
| `APP_ENV` | `production` | Turns on the fail-closed config guards (§8.3, §8.4). |
| `CACHE_BACKEND` | `postgres` | The Space has no persistent volume, so there is nowhere for the SQLite TTL cache to survive a restart and the cache has to live in the database (ARCHITECTURE.md §7). |
| `RATE_LIMIT_PER_HOUR` | `5` | **Required.** It must be a real injected variable rather than a file in the image: `config.py` checks `os.getenv` so that "unset" stays distinguishable from a deliberate value, and the backend refuses to boot under production without it (§8.4). |
| `RATE_LIMIT_DAILY_TOTAL` | `50` | Instance-wide backstop over the one paid Shodan key (§8.4). |
| `GUEST_SCAN_LIMIT_PER_DAY` | `2` | Scans per signed-out guest per rolling 24h (guest scan path, 2026-10-14 reversal). `0` disables guest scans: admission then answers 401 instead of 429, so switching it off reads as "not available" rather than a quota that will reset. |
| `GUEST_SCAN_DAILY_TOTAL` | `20` | The bound that actually costs money: instance-wide guest budget per rolling 24h. The per-guest number above is soft by construction (the identity is a cookie, and clearing it mints a new id), and the backend cannot bucket per IP because the only caller it sees is the Next proxy. Guest scans are charged to this *and* to `RATE_LIMIT_DAILY_TOTAL` when that is set, because both spend the same paid key. Keep it on while guest scans are on. |
| `MAX_REQUEST_BODY_BYTES` | (unset → `16777216`) | Ceiling on an inbound request body. It is enforced by `BodySizeLimitMiddleware` BEFORE anything reads the payload, because FastAPI solves dependencies — `require_user` included — only after `await request.body()`. Without it an anonymous caller can make the worker buffer an arbitrarily large body on the way to its 401. The default is sized by the largest legitimate body, the EXIF base64 upload (`(MAX_INPUT_BYTES // 3) * 4 + 4` ≈ 13.98 MiB) plus envelope overhead; `backend/tests/test_body_limit.py` pins that relationship, so raising it past the default reopens the bug and lowering it gives legitimate uploads a spurious 413. The frontend proxy applies the same 16 MiB cap. |

Three points the tables cannot carry:

- **`?ssl=require`, not `sslmode=require`** — the same driver rule as §8.1, and `config.py`'s guard accepts either spelling, so the wrong one only fails at connect time.
- **`BETTER_AUTH_SECRET` must equal the frontend's.** Two different values mean every scan 401s.
- **No region to align.** The Space runs where the platform runs it; there is no `fra`/`was` picker to argue with, unlike the earlier hosts (§8.1).

#### The IPv6 caveat (a real risk, with a fallback)

The direct Supabase endpoint `db.<project-ref>.supabase.co` may resolve to an **IPv6 address only**. If the Space has no IPv6 egress, every connection attempt fails while the container itself stays healthy: `/health` answers `{"status":"ok"}` because it is an in-memory liveness check that touches nothing, so the break looks like nothing at all until a scan 401s or `/ready` reports degraded. **Unverified:** whether a given Space has IPv6 egress cannot be determined from this repository, so treat that path as broken until it is proved otherwise.

`/ready` is the signal, because it opens one real database connection. If `/health` says ok and `/ready` is degraded, the backend cannot reach Postgres and the IPv6 path is the first suspect.

The fallback is the Supavisor pooler in **SESSION** mode: port **5432**, user `postgres.<project-ref>`, host `aws-0-<region>.pooler.supabase.com`, `?ssl=require`. Not transaction mode on 6543 — transaction pooling breaks SQLAlchemy's prepared statements, and that failure arrives as intermittent confusing errors rather than as a clean connection refusal. The pooler's connection budget is shared with the frontend (§8.1), which is the only reason to keep the direct URL otherwise.

#### Verification, in order

1. Create the Space with SDK **Docker** and the hardware tier you want, then confirm `backend/README.md` carries `sdk: docker` and `app_port: 7860` before the first push: that file becomes the Space's root README, and it is what declares the SDK and the port.
2. Add the `hf` remote and push the subtree. Expect the **first build to take several minutes** — the image is multi-stage and compiles Subfinder with Go before the runtime stage installs anything, and the container command runs `alembic upgrade head` before uvicorn serves.
3. `GET https://<user>-<space-name>.hf.space/health` → `{"status":"ok"}`, then `GET /ready` → `{"status":"ready"}`. `/health` alone proves only that the process is alive; `/ready` is the one that exercises `DATABASE_URL`, the TLS spelling, and the IPv6 path.
4. Set `BACKEND_URL=https://<user>-<space-name>.hf.space` in the Vercel project environment and redeploy the frontend. The browser never calls the backend directly — requests go through the Next.js proxy routes — so CORS is a second layer rather than the mechanism, and the exact origins still matter for the day something does call it directly.
5. Run the §8.2 step 6 check on the production domain: sign up, scan a public domain, sign out.

#### The Space sleeps, and the ping that stops it

Spaces sleep after an idle period — reported at roughly **48 hours**, but the exact window is neither documented nor guaranteed, so treat that number as unverified and read the Space's own logs rather than this paragraph. Either way `.github/workflows/keep-backend-awake.yml` still applies: a 5-minute `GET /health` holds the clock whatever the window turns out to be.

- Arm it by setting the repository variable `BACKEND_HEALTH_URL` to `https://<user>-<space-name>.hf.space/health` (Settings → Secrets and variables → Actions → Variables).
- Keep the existing caveat rather than assuming it away: GitHub's scheduler runs late under load — 15 minutes is routine and it can be worse. If the Space still sleeps, move the ping to an external scheduler (cron-job.org, UptimeRobot) instead of tightening this cron further.

#### Manual equivalent

The deploy itself is two git commands:

```powershell
git remote add hf https://huggingface.co/spaces/<user>/<space-name>
git subtree push --prefix=backend hf main
```

- Secrets and plain variables are set in the Space's **Settings → Variables and secrets** UI, or programmatically through `huggingface_hub`'s Space secrets API (`HfApi.add_space_secret` / `add_space_variable`). Saving either restarts the Space.
- The public URL is `https://<user>-<space-name>.hf.space` — the username is part of the hostname, so the Space name alone does not construct it.
- `deploy-koyeb.ps1` is retained for the Koyeb path, which remains a working alternative host: it wraps the same runbook, resolving the four load-bearing values from the environment, then `backend/.env`, then a hidden prompt, validating them, applying them before the service, and polling `/health` and `/ready` on the resulting public URL. It is deliberately stricter than `app/core/config.py` on one point — the config guard accepts `sslmode=require` because it cannot know which driver a given URL is for, but a *backend* URL must be `?ssl=require`, since asyncpg rejects `sslmode` as a keyword. Run it with `-DryRun` to validate everything and deploy nothing. It is no longer the active target.

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
