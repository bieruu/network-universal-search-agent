# WORKFLOW — Dev, Run, Ship

## 1. Prerequisites

- Node.js 20.6+, npm, Python 3.11+, and Docker with Compose
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
```

Generate a secret with `openssl rand -base64 32` or a trusted password generator. Do not commit real secrets or filled `.env` files.

## 4. Daily development

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
> - `backend` — installs the hashed `backend/requirements.txt` against a `postgres:16` service, then runs Alembic `upgrade head` **and** `check` (so a model change without a migration fails CI), `pytest -q`, `ruff check .`, and `black --check .`.
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

Target topology: frontend on Vercel, FastAPI in a container (Fly/Render), Postgres managed (Neon/Supabase).

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
- Keep TLS on the pooled endpoint. Production rejects a non-localhost Postgres URL that is missing `sslmode=require`.
- The backend talks to the same database through SQLAlchemy/asyncpg and should use the same pooled endpoint in production, bounded by its own pool size.
- `BETTER_AUTH_SECRET` must be the same value on both sides, and it must match what the migration in §8.2 step 3 ran against.

### 8.2 Deploy runbook (ordered — do not skip or reorder)

1. **Confirm the database and its pooled URL.** Create the database if it does not exist, and keep the pooled connection string from §8.1 handy for both apps.
2. **Backend schema first — from `backend/`:** `alembic upgrade head`. For an existing database created by the old startup `create_all`, verify that its `targets`, `scans`, and `findings` tables match the initial revision before the one-time `alembic stamp head`; never stamp a schema you have not checked.
3. **Frontend auth schema — from `frontend/`:** `npm run auth:migrate`. This script reads `DATABASE_URL` from `frontend/.env.local`, so point it at the pooled production database before running it; do not run it inside the Vercel build.
4. **Only then set the production origin variables**, once the domain is final:
   - Frontend (Vercel project env): `BETTER_AUTH_URL=https://<prod-domain>`, `NEXT_PUBLIC_APP_URL=https://<prod-domain>`, plus `BETTER_AUTH_SECRET`, the pooled `DATABASE_URL`, and `BACKEND_URL=https://<backend-host>`. Set `SIGNUP_ENABLED` (and `SIGNUP_EMAIL_ALLOWLIST` if sign-up should be restricted) — see §8.3. It is **required** for step 6: self-service sign-up is closed by default under `NODE_ENV=production`, so step 6 fails at the sign-up step until the flag is set.
   - Backend (container env): `CORS_ORIGINS=https://<prod-domain>` (exact origin, no trailing slash, no wildcard), `APP_URL=https://<prod-domain>`, plus the same secret and the same database. `RATE_LIMIT_PER_HOUR` is **required** and the backend refuses to boot without it — see §8.4. Set it as a real container/host environment variable, not only a `.env` file inside the image.
5. **Deploy the backend container first** and confirm it responds, then deploy the frontend to Vercel. Any release that changes a schema repeats steps 2 and 3 before it takes traffic.
6. **Verify end to end on the production domain:** sign up, run a scan against a public domain, sign out. A successful build is not proof that auth works in production.

Other deployment notes:

- Backend: `APP_ENV=production`, `SHODAN_API_KEY`, and `CACHE_BACKEND=postgres` on hosts without a persistent volume (see ARCHITECTURE.md §7). The rate limiter is per-process, so run a single uvicorn worker in production.
- On non-container hosts, install Subfinder separately and make it available on the backend `PATH` to enable the final bounded certificate-transparency fallback. The backend Docker image builds and includes Subfinder v2.16.0.
- If crt.sh is unavailable, the backend tries Cert Spotter before Subfinder. A successful fallback is shown as the provider for the certificate-transparency results and cached. Cert Spotter's anonymous free tier limits full-domain queries to 10 per hour; a source error is reported only if every passive fallback fails.
- Configure OAuth callback URLs for the deployed origin. Do not advertise or mark a provider verified until a live callback succeeds.
- Rotate secrets through the relevant provider/host dashboards; never place secrets in client-prefixed variables or source control.

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
