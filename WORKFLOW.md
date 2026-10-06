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
pip install -r requirements.txt
alembic upgrade head
uvicorn app.main:app --reload --port 8000
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
```

`backend/.env`:

```dotenv
SHODAN_API_KEY=<key>
DATABASE_URL=postgresql+asyncpg://osint:osint@localhost:5432/osint
BETTER_AUTH_SECRET=<same-random-secret-as-frontend>
CORS_ORIGINS=http://localhost:3000
APP_URL=http://localhost:3000
SQLITE_PATH=./data/cache.db
CACHE_BACKEND=sqlite
NVD_API_KEY=                # optional — raises NVD rate limits
SCAN_TIMEOUT_NVD=12
NVD_MAX_CPES=5
NVD_CVES_PER_CPE=20
NVD_PAGE_SIZE=100
RATE_LIMIT_PER_HOUR=10
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

# Backend, from backend/ with its environment activated
alembic check
pytest -q
ruff check .
black --check .
```

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

- Frontend: deploy `frontend/` with `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, standard PostgreSQL `DATABASE_URL`, `NEXT_PUBLIC_APP_URL`, `BACKEND_URL`, and optional provider credentials.
- Database: use the same PostgreSQL database for frontend auth and backend application data. Run `npm run auth:migrate` from `frontend/` and `alembic upgrade head` from `backend/` before serving traffic. For an existing database created by the old startup `create_all`, verify its schema before the one-time `alembic stamp head`; never stamp a database whose schema has not been checked.
- Backend: provide the same secret and database (backend URL uses `postgresql+asyncpg://`), `SHODAN_API_KEY`, exact `CORS_ORIGINS`, and production `APP_ENV=production`.
- On non-container hosts, install Subfinder separately and make it available on the backend `PATH` to enable the final bounded certificate-transparency fallback. The backend Docker image builds and includes Subfinder v2.16.0.
- If crt.sh is unavailable, the backend tries Cert Spotter before Subfinder. A successful fallback is shown as the provider for the certificate-transparency results and cached. Cert Spotter's anonymous free tier limits full-domain queries to 10 per hour; a source error is reported only if every passive fallback fails.
- Configure OAuth callback URLs for the deployed origin. Do not advertise or mark a provider verified until a live callback succeeds.
- Rotate secrets through the relevant provider/host dashboards; never place secrets in client-prefixed variables or source control.
