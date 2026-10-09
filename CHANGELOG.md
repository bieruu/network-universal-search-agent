# Changelog — Network Universal Search Agent

> Completed work only, newest section at the top. Open items → [TODO.md](./TODO.md) · setup → [WORKFLOW.md](./WORKFLOW.md) · requirements → [PRD.md](./PRD.md).
> Anything finished in a push moves here from TODO.md in that same commit, newest section at the top — see AGENTS.md §9.

## 2026-10-10 — Backend host moved to Koyeb: Fly could not be deployed without billing

`backend/fly.toml` and `deploy-fly.ps1` are deleted, `render.yaml` is deleted, and the backend target is now Koyeb. Nothing is deployed: no Koyeb app exists and no Vercel project exists, so there is still no public URL and nothing here has been proven against a running service.

The reason for moving again is recorded honestly rather than tidied away. The 2026-10-09 entry chose Fly on the grounds that **the deploy could be proven before a payment method existed**. That was true of a Fly *trial* and it is still the reason Fly was tried; it was never true of a long-running Fly app, which bills continuously from the first minute because Fly has no free allowance. So the property the previous entry was optimising for could not survive contact with actually hosting the thing.

- **A claim in the 2026-10-09 entry was wrong and is corrected here: Koyeb does have free compute.** That entry recorded "Koyeb has no free compute left". Per Koyeb's own documentation (last updated 28 May 2026), every organization gets one `free` web Service — 512 MB RAM, 0.1 vCPU, 2 GB SSD — which is never billed. The earlier survey passed over the one option that has what this project actually needs.
- **The card problem is not solved by moving.** Koyeb also requires a credit card at signup, via a $29 pre-authorization hold. This is recorded here because a reader skimming "moved to Koyeb" could otherwise conclude the card gate is behind us. It is not; it is the same gate.
- **`deploy-koyeb.ps1` (new, repo root)** replaces `deploy-fly.ps1` and keeps its shape and its reason to exist: resolve each value from the environment, then `backend/.env`, then a hidden prompt; validate the four failure modes that only surface *after* a several-minute build; then deploy and verify. It adds a `koyeb whoami` preflight, so a missing session fails with a clear message instead of an opaque 401 several steps later.
- **Secrets are set before the service, not after.** `DATABASE_URL`, `BETTER_AUTH_SECRET`, `SHODAN_API_KEY`, `CORS_ORIGINS` and `APP_URL` become Koyeb org-level secrets and are referenced with `--env KEY={{secret.NAME}}`, so the first deployment already has them. They are passed with `-v` rather than `--value-from-stdin` on purpose: piping a string into a PowerShell native command appends a newline, which would silently corrupt `APP_URL` and `CORS_ORIGINS`. Brief argv exposure on a one-shot local run is the smaller risk, and that tradeoff is commented in the file.
- **The script is deliberately stricter than `app/core/config.py` on TLS**, unchanged in spirit from the Fly version: the config guard accepts `sslmode=require` because it cannot know which driver a URL is for, but a *backend* URL must be `?ssl=require`, since asyncpg rejects `sslmode` as a keyword. The script rejects `sslmode=` outright rather than letting the container discover it at connect time.
- **Why the CLI and not a `koyeb.yaml`.** Koyeb does not publish that file's schema on its docs site, and its own example repository (`koyeb/example-docker-compose`) does not use one. Every flag in the script is taken from the published CLI reference, so nothing here is guessed. This is stated in WORKFLOW.md §8.6 so the next person does not hand-write one from memory.
- **The work directory is the build context.** `--git-workdir backend` is load-bearing, for the same reason it was on Fly: the Dockerfile copies `requirements.txt`, `alembic.ini` and `alembic/`, which exist only under `backend/`, and a repository-root work directory fails with `COPY failed: file not found in build context`.
- **Settings pinned, each with a reason in §8.6:** `free` instance; `--min-scale 1 --max-scale 1` (the rate limiter is per-process, so a second instance would multiply every `RATE_LIMIT_PER_HOUR` quota); `--checks 8000:http:/health` rather than `/ready`, which opens a database connection on every probe; `--checks-grace-period 8000=60`, because the container CMD runs `alembic upgrade head` before uvicorn serves.
- **Region alignment is impossible on this tier, and is documented as such rather than glossed.** The Supabase project is in `ap-northeast-1` (Tokyo); the `free` Instance is offered in Frankfurt and Washington DC only. WORKFLOW.md §8.1 now says so plainly, with Tokyo named as what a paid Instance type would buy.
- **`.github/workflows/keep-backend-awake.yml` (new)** pings `GET /health` every 5 minutes. The `free` Instance sleeps after 1 hour idle and that idle period cannot be disabled on this tier, so something has to hold the clock — this is the mitigation for the cold-backend 504 already documented in §8.2. `/health` is used deliberately: `/ready` would also hold the service awake but opens a Postgres connection on every probe, spending the free Supabase connection budget on a keepalive. It is armed by setting the repository variable `BACKEND_HEALTH_URL`, and skips with a warning when that is empty rather than failing. The known limitation is stated in the file and in §8.6: GitHub's scheduler runs late under load, and if the backend still sleeps the fix is an external scheduler, not a tighter cron.
- **`ping-supabase.yml`: `RENDER_READY_URL` renamed to `BACKEND_READY_URL`.** The variable still carried the old host's name, so the backend readiness probe was silently keyed to a provider that no longer hosts anything. The behaviour is unchanged — still opt-in, still skipped when empty — and the comment describing what a 401 there proves now names the host generically.

Gates run in this push, all green, unchanged from the pre-change baseline: `pytest -q` → **1003 passed** (1 warning, 210s); `ruff check .` → **All checks passed**; `black --check .` → **83 files would be left unchanged**; frontend `npm run lint` → exit 0 with no output; `npm run tsc --noEmit` → exit 0, no errors; `npm test` → **152 pass, 0 fail** across 15 files (2.7s).

What is **not** verified: nothing in this entry has been exercised against a live Koyeb service. The settings were checked against Koyeb's published documentation and its CLI reference, not against a running deployment. TODO.md keeps both the hosting item and the cold-backend item open and unticked for exactly that reason.

## 2026-10-09 — Backend host moved to Fly.io: the Render card gate closed the free path

> **superseded 2026-10-10** → [the 2026-10-10 entry above](#2026-10-10--backend-host-moved-to-koyeb-fly-could-not-be-deployed-without-billing). `backend/fly.toml` and `deploy-fly.ps1` were deleted, `render.yaml` was deleted, and the backend target is Koyeb. Two claims below did not survive: this entry says Koyeb has no free compute (it does — one `free` web Service per organization, never billed), and it chose Fly on the basis that the deploy is provable without a payment method, which holds for a Fly trial but not for a Fly app that bills continuously. The original reasoning is left intact as the record of what was believed on this date.

Render's signup demands credit-card verification even for the $0 `free` compute plan, and the card available here is declined, so the documented Render topology cannot be executed. Every no-card-free alternative was checked rather than assumed, and none of them can host this backend: Fly has no free allowance (though its *trial* needs no card), Koyeb has no free compute left, Hugging Face Docker Spaces now require a paid plan, Railway/GCP/AWS/Azure/Oracle all need a billing account, and Vercel or Cloudflare Workers are technically impossible because `tls_service` opens raw TCP sockets and asyncpg needs real TCP. So the backend moves to Fly, chosen for the property that matters here: **the deploy can be proven before any payment method exists.**

- **`backend/fly.toml` (new)**, deliberately inside `backend/`. Fly's `[build] dockerfile` does not change the Docker build context — that stays the directory the deploy runs from — and the Dockerfile copies `requirements.txt`, `alembic.ini` and `alembic/`, which exist only there. Deploying from the repository root would fail with `COPY failed: file not found in build context`, so the file sits beside the Dockerfile and the runbook says `cd backend && fly deploy`. That also means one Dockerfile serves both Fly and the retained `render.yaml`.
- **Region `nrt` (Tokyo)** rather than Singapore, because the Supabase project lives in `ap-northeast-1` and every scan touches the database.
- **`auto_stop_machines = "off"`, deliberately.** The operator asked for a backend that does not depend on their machine, and stopping would buy almost nothing: a stopped Machine is still billed for its root filesystem, while the Machine the next request wakes pays its cold start inside the 60 seconds the Vercel proxy allows for a scan — which is precisely how a scan becomes an edge 504 (the failure mode already documented in §8.2). Stated plainly in the file: this size bills continuously and Fly has no free allowance.
- **Health check on `/health`, not `/ready`** — `/ready` opens a database connection on every probe — with a 30s grace period because the Dockerfile CMD migrates before it serves. `kill_signal`/`kill_timeout` are top-level keys; they were initially written below `[vm]`, where TOML would have silently swallowed them as `[vm]` settings, caught by parsing the file rather than by reading it.
- **WORKFLOW.md §8.6** is the new runbook: `fly launch` → `fly secrets set` (DATABASE_URL with `?ssl=require`, the shared `BETTER_AUTH_SECRET`, `SHODAN_API_KEY`, `CORS_ORIGINS`, `APP_URL`) → `fly deploy`. `render.yaml` stays as the alternative for anyone whose card Render accepts, and §8's topology line now says which one is active.

Nothing is deployed: no Fly app exists and no Vercel project exists, so there is still no public URL. Gates were not re-run for this push — it adds one TOML file and documentation, no Python or TypeScript. The TOML was parsed and asserted instead (`kill_signal` present at the top level, absent from `[vm]`), and the numbers in the previous entry stand.

## 2026-10-09 — Database is live and verified end to end; the Postgres cache path was silently broken

Executing the deploy runbook by hand turned up one production bug that no test could have caught, and finished the database work that had been open since 2026-10-06. **Nothing is deployed to the public internet** — Vercel and Render have not been touched — but the full path (browser → Next proxy → FastAPI → Supabase) now runs and is proven.

- **The Postgres TTL cache could never connect to a managed database, and failed invisibly.** `app/core/cache.py` passed the whole URL to `asyncpg.connect(dsn=…)`, and asyncpg parses DSN query parameters as **server settings**, not connection options, so the `?ssl=require` that WORKFLOW.md §8.1 prescribes arrived at Postgres as a runtime parameter and was rejected: `CantChangeRuntimeParamError: parameter "ssl" cannot be changed now`. The damage is the quiet part — `cache_get_async`/`cache_set_async` swallow every exception by design ("a dead cache must never 500 a scan"), so there was no log line, no failed request, and no symptom anywhere except that **nothing was ever cached and every scan paid for Shodan again**. That is exactly the budget the per-account rate limit exists to protect. `_pg_dsn` is replaced by `_pg_connect_kwargs`, which parses the URL and moves TLS out of the query string into the `ssl=` keyword asyncpg actually accepts, with `unquote()` so a password containing reserved characters is not handed over still percent-encoded (a correct password that fails to authenticate). Six tests, including one that fakes asyncpg and asserts the DSN is never passed positionally again. Live proof after the fix: `osint_cache` exists and holds rows for `crtsh:example.com`, `history:example.com`, and `whois:example.com`.
- **`npm run auth:migrate` could report success having done nothing.** The Better Auth CLI asks `Are you sure you want to run these migrations? (y/N)`. Without an interactive terminal the answer is **no**, and it exits **0** with no tables created — a deploy script would read that as success. The script now passes `--yes`, and §8.2 step 3 says to check for the four tables instead of trusting the exit code.
- **The TLS parameter is driver-specific in three mutually incompatible ways**, all reproduced against the pinned drivers and now a table in WORKFLOW.md §8.1 rather than a footnote: asyncpg needs `?ssl=require` and rejects `sslmode` as a keyword; node-postgres needs `?sslmode=no-verify` and, given `?ssl=require`, dies with `Cannot use 'in' operator to search for 'key' in require`; and the cache path had a third behaviour of its own. One working connection string therefore cannot be copied between the two sides.
- **Supabase is chosen, provisioned, and verified** — this closes the "pilih DB managed + endpoint pooled + TLS" item from TODO.md, swept here per AGENTS.md §9. Project `ap-northeast-1`, frontend on the Supavisor session pooler (port 5432, user `postgres.<ref>`), backend on the direct endpoint. Verified through **each side's own driver**, since a probe using the wrong one reports a healthy database as broken: both connections up with TLS on, and all seven tables present with the columns the code actually queries — including `session.userId`/`expiresAt`, which the session lookup in `app/core/security.py` needs, executed against the real database rather than inferred from a table list.
- **Verified in a real browser**, not just by HTTP status. Chrome driven over the DevTools Protocol: signed up through the form, landed on `/dashboard`, ran a scan of `example.com`, and reloaded `/dashboard` with the session intact. The scan landed `partial` with `scan_id c08c987e-61c6-4952-9e27-79531141d362` and one source error, `shodan: SHODAN_API_KEY not configured` — the documented behaviour with no Shodan key — while crt.sh contributed **2 subdomains** through the database round trip. The database now holds 1 target, 1 scan, 1 user, 1 session, 0 findings.

Gates on this tree: `pytest -q` → **1003 passed** (1 Starlette/httpx deprecation warning), `ruff check .` → **all checks passed**, `black --check .` → **83 files unchanged**, `npm run lint` → **0 problems**, `npm run tsc --noEmit` → **no errors**, `npm test` → **152 pass, 0 fail**.

Still not done, and not claimed: no Vercel project and no Render service exist, so `BACKEND_URL` is unset and the public URL does not exist yet. The frontend's database connection is encrypted but does not authenticate the server certificate (`no-verify`, §8.1 and the open TODO item) — "TLS is verified" would be false here. A database password was pasted into a chat transcript during this work and must be rotated. The local backend and frontend started for this verification are still running on ports 8000 and 3000.

## 2026-10-09 — The frontend TLS advice was wrong: `sslmode=require` cannot reach Supabase

Found by running the deploy runbook for real instead of reading it, which is the only way this class of bug is findable. Nothing is deployed; the runbook is still being executed by hand.

- **`npm run auth:migrate` against Supabase failed with `SELF_SIGNED_CERT_IN_CHAIN`, and the spelling recommended for the frontend was the cause.** In the installed `pg-connection-string`, `sslmode` values `prefer`, `require`, and `verify-ca` are all handled as **aliases for `verify-full`** — the code emits its own deprecation warning and then falls through to the verifying branch — so the certificate chain is authenticated and the managed provider's chain is not trusted by Node's default CA bundle. `node_modules/pg-connection-string/index.js`, checked in the installed copy. WORKFLOW.md §8.1 said `?sslmode=require` for the frontend; it now says `?sslmode=no-verify`, which is the branch that sets `rejectUnauthorized = false`. §8.1's TLS bullet was rewritten at the same time: the production guard in `config.py` covers the **backend's** URL only, so its parameter names say nothing about the frontend's, and the old wording invited exactly this copy-paste.
- **What `no-verify` costs, stated plainly:** the hop is encrypted but the server certificate is not authenticated, so there is no protection against an active man-in-the-middle. Doing it properly means passing Supabase's CA bundle as `sslrootcert` to a path that also exists inside the deployed Vercel function, which is open work in TODO.md rather than something this push claims to have solved. Until that lands, "TLS is verified" would be a false claim about this deployment and must not be written anywhere.
- **A database password was pasted into a chat transcript while running these steps.** The value has to be treated as compromised and rotated in the Supabase dashboard; the local connection strings carry the new one. No repository file, workflow, or blueprint ever received it — the secret scan over the tracked tree found only placeholders and doc references — and the two run commands below set the URL from the shell rather than writing it to disk. Worth recording because the runbook gives no warning about this, and pasting a connection string into a terminal paste or an assistant chat is the obvious way to leak it.
- **The backend migration produced no tables and its output was not captured, so it is undiagnosed.** The steps below were run against the Supabase **pooler** URL rather than the direct one the runbook asks for, and the alembic output was not preserved. Not attributed to a cause, because there is no evidence for one yet; re-run against `db.<project-ref>.supabase.co` with `?ssl=require` and paste the full output. The frontend migration never got far enough to create anything, so "no tables at all" is consistent with both.
- **Region alignment is only partly available.** The Supabase project is in `ap-northeast-1` (Tokyo); Render offers Oregon, Ohio, Virginia, Frankfurt and Singapore, and no Tokyo region. Recorded in §8.1 with the guidance that recreating a not-yet-deployed project in `ap-southeast-1` is cheap and same-region is better, while once data exists a cross-region hop is the cheaper mistake to keep.

### Steps to re-run, in order

```powershell
# backend/ — direct connection, not the pooler
$env:DATABASE_URL = "postgresql+asyncpg://postgres:PASSWORD@db.<REF>.supabase.co:5432/postgres?ssl=require"
.\.venv\Scripts\python.exe -m alembic upgrade head          # keep the full output

# frontend/ — pooled connection, no-verify on purpose
$env:DATABASE_URL = "postgresql://postgres.<REF>:PASSWORD@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres?sslmode=no-verify"
npm run auth:migrate

$env:DATABASE_URL = $null                                  # so local dev stops pointing at production
```

Expected: seven tables (`targets`, `scans`, `findings`, `user`, `session`, `account`, `verification`) in the Supabase SQL editor; `osint_cache` is created on first cache use. Gate numbers are unchanged from the previous entry — this push touches Markdown only and no test reads these files.

## 2026-10-09 — Deploy records: the asyncpg TLS spelling trap, and why a cold backend is a 504

> **superseded 2026-10-09** (same day, section above): the frontend TLS spelling recorded in WORKFLOW.md §8.1 by the commit `c3cb9c3` this entry refers to — `?sslmode=require` — does not work against a managed provider and was corrected after being tried for real. The backend half of the driver split below (`ssl=require`, not `sslmode=require`) is unaffected and was independently reproduced here.

The deploy configuration itself — `render.yaml`, `frontend/vercel.json`, and the `ssl` vs `sslmode` correction in WORKFLOW.md §8.1 — landed earlier today in `c3cb9c3`. This push adds the two records that were still missing, both found while executing the runbook rather than by reading the code.

- **One line in WORKFLOW.md §8.1 could still hand you the crash.** The bullet immediately above the new subsection said production "rejects a non-localhost Postgres URL that is missing `sslmode=require`", which is true of the guard but reads as an instruction — and copying it into the backend URL passes validation and then dies on first connect. It now names both spellings and hands off to the subsection that explains the split. `config.py` accepting either spelling is the whole reason this is worth writing down: the guard cannot tell you which one you got wrong.
- **A cold backend fails at the edge, not in the app.** The proxy routes hold one request open for the backend's full duration and declare no `maxDuration`, so they inherit Vercel's Hobby ceiling of 60s. A scan fits inside that — the orchestrator gathers its sources concurrently, so wall-clock tracks the slowest per-source timeout (`SCAN_TIMEOUT_CRTSH`, 30s) instead of the sum — but a sleeping host spends its wake-up inside the same budget, so the first scan after an idle period can time out at the edge while the backend is still booting. Documented with the cheap operational mitigation (warm the backend URL once, then scan). Declaring `maxDuration` and returning a legible error instead of a bare 504 is **not** done; it is open work.
- **Backend hosting is undecided, and it is not a repo problem.** Render's signup demands a credit card even for the $0 `free` compute plan, so no service can be created from this account. Render's own free-tier documentation still says no payment method is required, so the docs lag the signup flow; whether that is account-level anti-fraud or a skippable step is **unverified**. Every alternative was checked rather than assumed, and none is free-without-a-card for a Python container backend: Fly.io has no free tier and requires a card on file, Koyeb has no free compute left, and **Hugging Face Docker Spaces now require a paid plan** — the documentation states "Gradio and Docker Spaces run on compute and require a paid plan to create", so the earlier assumption that a free CPU Basic Space would take this backend does not hold. Recorded in TODO.md with the two paths that remain (a card that passes verification, at no cost, since a free instance is never charged; or the operator's own machine behind a tunnel, whose URL changes on every restart).

Gates run on this tree before these edits: `pytest -q` → **998 passed** (1 Starlette/httpx deprecation warning), `ruff check .` → **all checks passed**, `black --check .` → **83 files unchanged**, `npm run lint` → **0 problems** at `--max-warnings=0`, `npm run tsc --noEmit` → **no errors**, `npm test` → **152 pass, 0 fail**. Everything this push touches is Markdown, and no test reads these files, so the gates were not re-run afterwards.

Not done, and not claimed: nothing is deployed. No Supabase project exists, no migration has run against a managed database, no Vercel or Render service has been created, and this entry does not include the GitHub Actions result for this commit — the numbers above are local, not CI. Verified while writing this entry: `region: singapore` is a real Render region, and every secret in that blueprint is `sync: false`, so applying it prompts for each credential instead of deploying one.

The previous push went out with all three CI jobs red. Each failure was a real bug that no local gate could catch, because the local environment differed from CI's in exactly the ways that mattered. All four were reproduced before being fixed. **One of them would have stopped the backend container from starting on Render.**

- **The container image could not import `urlscan_service` (production blocker).** The query was built with `f"{field}:{_RESERVED_RE.sub(r'\\\1', candidate)}"`. A backslash inside an f-string expression is a `SyntaxError` before Python 3.12 (PEP 701), and both the Dockerfile (`python:3.11-slim`) and CI pin 3.11 — the module raised at import time, so the app would never have booted in production. It only ever ran locally, on 3.14. The substitution is hoisted out of the f-string now.
- **`alembic upgrade head` failed for every invocation except the container's.** `alembic/env.py` imports `app.db.base`, but `alembic.ini` never put the backend directory on `sys.path`. `python -m alembic` worked by accident — running a module puts the CWD on `sys.path` — which is why the Dockerfile CMD passed while CI, the README quickstart, and every manual run died instantly with `ModuleNotFoundError: No module named 'app'`. Fixed with `prepend_sys_path = .`.
- **CI installed the runtime dependency file, then ran the test tooling.** `pytest`, `ruff` and `black` live in `requirements-dev.txt`, not `requirements.txt`, so three more steps were queued behind a `command not found`. The backend job now installs `requirements-dev.txt` (a superset of the runtime file) and caches both.
- **The frontend suite cannot run on the Node version CI pins.** `npm test` runs `.ts` files directly through `node --test`, which needs Node's native type stripping. On Node 20 every test file dies with `ERR_UNKNOWN_FILE_EXTENSION ".ts"` — reproduced on `node:20.20.2` (15/15 files fail) against `node:22.23.3` (152/152 pass). CI now uses Node 22, and the documented floor moves from 20.6 to **22.18** in README.md, WORKFLOW.md §1 and AGENTS.md §2 — the old floor was a claim the repository's own gates contradicted.
- **Secret scan: a test fixture read as a credential.** A module-level constant in `test_otx_service.py` was named `API_KEY` and held a fake OTX credential, which gitleaks flags as `generic-api-key` — reproduced locally over the pushed range before anything was changed. Renamed to `OTX_HEADER`, named for the header it is sent in, rather than allowlisted, so the scan stays strict. The literal is still in commit `1fe76ea`; it authenticates nowhere. Worth knowing for anyone who hits this again: the first fix attempt **also failed the scan**, because this changelog entry had quoted the literal verbatim while describing it. Prose about a secret is still a secret to a diff scanner.

**Gates, run this session:** `pytest -q` → 998 passed locally (3.14) **and 998 passed on Python 3.11 in a container**, matching CI's interpreter; `ruff check .` clean; `black --check .` → 83 files unchanged; `alembic upgrade head` + `alembic check` through the console script against Postgres 16 → no drift; frontend on `node:22.23.3` → `eslint` clean, `tsc --noEmit` clean, 152/152 pass. CI run #3 then confirmed `backend` and `frontend` green end to end (migrations, tests, style, `pip-audit`, `npm audit`, build). **The secret scan was still red on that run** — the changelog bullet below had quoted the fixture literal, which the scanner reads as a credential in a `.md` file exactly as it does in code.

**Not verified here:** nothing outstanding. Run #4 (`19065d2`) is the first in this repository's history with all three jobs green — `backend` (migrations, 998 tests, style, `pip-audit`), `frontend` (lint, tsc, 152 tests, `npm audit`, build) and the secret scan.

One artifact worth knowing: `ruff check .` inside a Windows-mounted container reports EXE002 on every file, because the bind mount exposes them as executable. That is the container, not the repository.

## 2026-10-09 — Deploy configuration: Render blueprint, Vercel config, and the asyncpg TLS trap

> **superseded 2026-10-10** → [the 2026-10-10 entry above](#2026-10-10--backend-host-moved-to-koyeb-fly-could-not-be-deployed-without-billing). `render.yaml` has been deleted; the backend target is now Koyeb and `deploy-koyeb.ps1` replaces the blueprint. The `ssl` vs `sslmode` correction documented below is **not** superseded — it still holds, and the new script enforces it.

Prepares the repo for Vercel (frontend) + Render (backend) + Supabase (Postgres). **Nothing is deployed by this push** — no Supabase project exists, no service was created, and no migration was run against a managed database. Every "Deploy readiness" item in TODO.md therefore stays unticked.

- **`render.yaml` (new, repo root).** The backend blueprint: `rootDir: backend` (where the Dockerfile is), `dockerfilePath: ./Dockerfile`, `healthCheckPath: /health`, `plan: free`, one instance, `region: singapore`. Every secret is `sync: false`, so Render prompts on apply and no credential is committed. It also pins `CACHE_BACKEND=postgres` (a free-tier filesystem is ephemeral, so a SQLite TTL cache is a cache that evaporates), `RATE_LIMIT_PER_HOUR=5`, and `RATE_LIMIT_DAILY_TOTAL=50` — the instance-wide ceiling that matters specifically because self-service sign-up is open, where N accounts each inside their own quota still add up against one paid Shodan key.
- **`frontend/vercel.json` (recreated).** `framework: nextjs` + `$schema`, nothing else. WORKFLOW.md §8 and the 2026-10-07 entry both describe this file, but it was not present in the tree — see the note on that entry.
- **A TLS trap that fails at connect time, not at boot time.** `app/core/config.py` accepts either `sslmode=require` or `ssl=require` in the production guard, but they are not interchangeable for the backend. SQLAlchemy splits the connection URL's query string into `asyncpg.connect()` keyword arguments, and asyncpg takes `ssl` while rejecting `sslmode`: `TypeError: connect() got an unexpected keyword argument 'sslmode'` — reproduced against the pinned sqlalchemy 2.1.2 + asyncpg 0.31 in this session's venv. So the spelling the guard accepts *and* WORKFLOW.md §8.1 used to recommend is the one that crashes on the first database connection, on a deploy that otherwise looks healthy. The backend needs `?ssl=require`; the frontend keeps `?sslmode=require`, because `pg` parses `sslmode` out of the connection string itself. WORKFLOW.md §8.1 now states both, with the reason.
- **Supabase specifics added to WORKFLOW.md §8.1.** Two endpoints for one database (the backend reads the Better Auth `session` table directly, so a second project for the frontend would 401 every scan); frontend on the pooler at port 5432 session mode, backend on the direct host; URL-encode the password; free-plan projects auto-pause after 7 days of low activity and the database connection budget is finite (engine pool + Alembic + the cache path, which opens a connection per call rather than using the pool).
- **Runbook cross-referenced** to `render.yaml` in WORKFLOW.md §8, with the note that the backend keeps one instance because the rate limiter is per-process.

**Gates, run in this session:** `pytest -q` → 998 passed, 1 warning; `ruff check .` → all checks passed; `black --check .` → 83 files unchanged; `eslint . --max-warnings=0` → clean; `tsc --noEmit` → clean; `npm test` → 152 pass, 0 fail; `npm run build` → compiled, 10 routes; `alembic upgrade head` + `alembic check` against a throwaway Postgres 16 (container created for the check and removed after) → 4 tables, "No new upgrade operations detected".

**Not run here:** `pip-audit`, `npm audit`, and the gitleaks scan — CI-only, and they run on this push. No migration has been applied to any *managed* database, and no deploy was performed.

## 2026-10-08 — v2 analysis: SSRF guard, per-capability endpoints, threat/incident history

*(corrected 2026-10-09: the code this entry describes was never committed — those files were untracked in the working tree. This push is what actually landed it.)*

Ships both "do NOT start" v2 sections. The blocking prerequisite first — the SSRF guard — then the modules it unlocks, plus the history fallback and its four sources. **913 backend tests, 151 frontend tests, `ruff`/`black`/`eslint`/`tsc` all clean** (numbers observed this session).

**The SSRF guard (`app/core/ssrf.py`) — the fail-closed gate everything else stands on**

The existing target check is a string check plus one resolution of the name the user typed. That is enough for a target we only ever *look up* in Shodan/crt.sh/WHOIS. It is not enough for a module that makes the backend **connect** to a target, because the connection follows a path the initial check never sees: a 302 to `169.254.169.254`, a 302 to `localhost:5432`, a public name that resolves to loopback *at connect time*, or `http://2130706433/` (glibc's resolver reads that as `127.0.0.1`).

`SafeFetcher` is now the only sanctioned fetch path, and it closes four gaps: only `http`/`https` and no URL userinfo; **every** address the name resolves to is re-checked and the request goes to a **pinned IP literal** with `Host` + SNI restored (pinning is what closes rebinding, and it also normalises `2130706433`/`0.0.0.0`/AAAA to the IP they actually are before being judged); redirects are followed **manually**, one validated hop at a time, capped at 10; response bytes are capped while streaming. The client is built with `trust_env=False` — load-bearing, not a preference, because with the default an `HTTP_PROXY` in the environment silently moves the connection off the pinned IP and undoes all of it. `validate_host(host, port)` is the public seam for the one module that opens its own socket.

Two real bugs surfaced while building it:

- **`0.0.0.0` was not blocked.** It is not `is_private`, `is_loopback`, `is_link_local`, `is_reserved` or `is_multicast` in Python's `ipaddress`, so `is_blocked_target` passed it — and Linux connects `0.0.0.0` to the loopback interface. Now covered by `is_unspecified` plus `0.0.0.0/8` and `::/128`.
- **`assert_target_allowed("http://127.0.0.1/")` was a no-op.** It inspects the whole string for an IP literal, and a URL is not one, so the analysis router's defence-in-depth check validated nothing. The router now parses and checks the host.

A third was found by the existing perf test rather than by inspection: the history fallback initially fired on a **pure cache hit**, which broke the rule the orchestrator is built on (a cache hit costs zero network). The chain now runs only when the scan itself did work, or on `force=true`.

**Per-capability endpoints (`routers/analysis.py`)** — one endpoint per capability, deliberately not a combined call: a module that fails must not take down the others, and with no shared fan-out there is nothing to fail together. A policy or upstream failure is **HTTP 200 with an entry in `errors[]`**; only a caller mistake is 4xx. A blocked target must never look like a server error *and* must never look like "no findings". `GET /capabilities` exists because several sources ship dark by design — it lets the UI say *why* a card is empty.

Capabilities that cost no Shodan credit use a **new `check_free_rate_limit`, not `check_rate_limit`**. The hourly scan quota is a billing decision about one shared paid key, so aliasing them would burn money budget on free work and let a contact lookup exhaust a user's scan allowance. Separate quota and keyspace, shared sweep and memory ceiling, and deliberately **excluded** from the instance daily cap, which exists to bound spend on the paid key.

**Modules, and the alternative chosen where the obvious route was blocked**

| Module | Note |
|---|---|
| `host_enrichment_service` | Diff-first, as the TODO demanded: Shodan already paid for all 15 fields and the normalisation boundary was **dropping 11 of them**. So this is a thin synchronous derivation, **no second paid key** (no Censys/MaxMind/ipinfo). A test AST-asserts it imports nothing networking-related, so it cannot drift into a scanner — `AGENTS.md §7` bars active scanning. |
| `dns_service` | Seven record types, concurrent on `dns.asyncresolver` (worst case one timeout, not seven); per-type isolation; TXT cut to 512 chars; NXDOMAIN distinguished from an empty answer. The **sync** resolver is never used and a test makes accidental use fail loudly. |
| `tls_service` | Live handshake, the only module that opens a raw socket. Client-side verification is **deliberately off** (`CERT_NONE`): a scan must *report* an expired or self-signed certificate, and validating client-side would hide the finding the module exists to surface. `cryptography` parses the DER, since the stdlib refuses to decode it when verification is off. The diff found that `risk._cert_expiry_factor` scores TLS from **CT issuance history**, which can be a stale entry — render validity once, from here. |
| `http_headers_service` | `Set-Cookie` **values are never emitted** — not partially masked, absent — and the `headers` list carries `set-cookie` as `[redacted]` too, because echoing `name=VALUE` there leaks the same secret through a second door. `authorization`/`proxy-authorization` likewise. |
| `redirect_service` | Reports the chain from the hops the guard already recorded; the hop cap becomes a **result** (`truncated: true`), not a 500. `downgrades_to_http` means an https→http *transition*: an all-plaintext chain reports `False`, because `http→http→http` never left http and a red badge would lie. |
| `sitemap_service` | The XML hardening is the module. ElementTree resolves no external entities but **does** expand internal ones, and expat's amplification ceiling is a *threshold, not a guarantee* — six levels of ten expanded a 200-byte DTD to 1,000,000 chars in 21 ms with no error. So a DTD in the prolog is rejected by string scan before any parser sees the bytes. |
| `contact_service` | An address-harvesting primitive, so: a hard cap of **100 matches total** on one shared counter (the limit cannot be gamed by page shape), no verification or enrichment of any kind, and a `contact` rate-limit scope of its own. |
| `exif_service` | **`exiftool` rejected in favour of Pillow in-process** — no new system binary, no shell-out over untrusted bytes, no temp file. Trade-off documented honestly: no maker notes, no RAW/HEIC. Type comes from **content**; GPS and serials report presence truthfully while withholding the value until opt-in, including inside `tags`, or the dedicated fields would be bypassable. |
| `phone_lookup_service` | `libphonenumber` offline, **synchronous** on purpose (a local parse in a thread hop costs more than the work). Carrier/line-type **omitted entirely** rather than stubbed behind a dead config knob — its ToS needs a paid source, and every result's `note` says so. Own endpoint and own bucket; verified through the OpenAPI schema that `ScanRequest` still takes only `{target, force}`. |

**Threat & incident history** — runs only when the vulnerability tab would otherwise be empty, reusing the `_certificate_fallback` shape rather than adding a parallel mechanism. Two orchestrator tests the TODO named: no CVEs → history runs; CVEs present → history **never** runs. Two more rules came out of implementation: a **total source failure** also disables it (if Shodan, crt.sh and WHOIS all failed we learned nothing, so "no CVE data" means "we could not check", and dressing an outage up as a result is the dishonest outcome), and the payload carries `trigger_reason` so the UI can say *why* it ran.

`ThreatHistoryCard` renders the three states apart, and "no records" is only reachable when every source that ran answered `ok` with zero — anything unreachable flips it to "incomplete coverage", so the card cannot overstate coverage. `not_configured` (dark by design) is styled differently from `unavailable` (a failure).

**Rate-limit exemption for testing — `RATE_LIMIT_EXEMPT_SUBJECTS`**

Load/QA work kept hitting our own 429 before it reached the provider limits that actually govern it. Operators can now name subjects exempt from both buckets. Default empty: nobody is exempt.

Two properties make it safe rather than a backdoor:

- **It is keyed on the subject, and the only subject reachable without a secret is `user:service`.** `require_user()` returns `user:<db-id>` for a session cookie and `user:service` only for `Authorization: Bearer <SERVICE_TOKEN>` under `hmac.compare_digest` — a secret that never reaches a browser. So a stolen cookie or an XSS stays capped. Exempting a *browser* subject would delete the per-user quota, whose entire purpose is to stop one compromised account becoming a cost vector on the paid Shodan key. A test asserts end-to-end that a valid session cookie yields `user:user_123` and is not exempt even while `user:service` is.
- **An exempt call is not charged, not merely uncapped.** No bucket is created and `_count_instance` is skipped, so a load test cannot drain `RATE_LIMIT_DAILY_TOTAL` and hand the next real user a 429 for the test's spending.

Matching is exact (never a prefix), the setting is read per call so flipping it needs no restart, and every exempt call logs at WARNING with the subject name so a setting left on in production is visible. Operator steps and the `curl` form are in WORKFLOW.md §3.1. **It does not raise provider limits** — OTX (100 req/hour per IP) and Leak-Lookup (10 req/day per key) stay shared across all users.

**Filling the two empty cards — NVD keyword fallback, and OTX for real breach detail**

Both symptoms had the same shape: the card was *correctly* reporting "I have nothing usable", and rendering that as 0/blank read as broken.

- *Wiring bug in the fallback itself.* The orchestrator passed Shodan's `services[]` **dicts** to `nvd_service.derive_keywords`, which only iterates top-level **strings** — so it returned `[]` for every real payload, the fallback never ran, and the card stayed at 0 while the suite stayed green (the fixture happened not to exercise the path). Fixed via `_keyword_inputs`, which now draws terms from three sources in descending confidence: `services[].product`, then **the CPE vendor/product**, then hostnames. The CPE source is what rescues the common case — Shodan returns `cpe:2.3:a:cloudflare:cloudflare:*` with an **empty** product string, so a fallback keyed only on `product` found nothing. We already query that CPE, so the vendor/product pair is the best term available. Pinned by a test asserting the exact derived terms.
- *A correctness bug the fallback introduced, caught by an existing repo test.* When NVD returned `unavailable`, the fallback **overwrote** it with keyword leads — dressing an infrastructure outage up as a result and losing the `errors[]` entry that explains why the card is thin. It was also pointless: the keyword search queries the same NVD host, so it could only add a second redundant failure. `_keyword_fallback_allowed` now excludes `unavailable`, with a test.

- *Vulnerability card showed 0.* NVD enrichment only runs when Shodan returns CPEs, so a target with no CPE evidence never produced an `nvd` block at all. Added `nvd_service.search_keywords`, a `keywordSearch` fallback that runs **only** when the CPE path yielded nothing (`no_match`, `insufficient_evidence`, `unavailable`, or missing) and can therefore never downgrade real exact-match evidence. `keywordSearch` matches CVE **descriptions**, so a hit means "a CVE whose text mentions nginx exists" — nothing about this host. Three independent locks keep it that way, each with a test: every emitted CVE carries `keyword_derived`, `build_cve_rows` checks that marker **and** the result-level status/method (so a lost marker still cannot produce `verified`) and forces `evidence_cpe` to `None`; `risk.score` skips keyword rows on **both** the tiered and legacy paths, because without that a single CRITICAL description-mention would set `vulns = 1.0` and take a target to 100 — leads are surfaced as `breakdown["keyword_leads"]` instead, and `keyword_derived` joins `nvd_uncertain` so the card never reads as "checked, fine"; the UI shows a distinct badge, an `NVD (keyword)` source cell, and a caveat reserved before truncation so no cap can drop it. Keyword failures are deliberately **not** cached — one 429 cached for the 7-day CPE TTL would guarantee a week of no data.
- *Breaches found but no detail.* Leak-Lookup was returning its **public-key shape**: breach names with every indexed column stripped, so `matches` and `date` are `None` and the card rendered `—`. Added **`otx_service`**, which needs **no key at all** and returns real pulse names, descriptions, dates, tags, malware families and TLP. It leads the history chain because it is the one block that reliably comes back with detail. OTX's own honesty traps are handled: `reputation` is never surfaced as a score (always-`0` in `/general` vs `null` in `/reputation`, with no documented scale — the result is built from `pulse_info.count` plus OTX's own `validation[]`/`false_positive[]` instead); **TLP amber/red pulses are withheld** and flagged `tlp_restricted`, since those are non-public by LevelBlue's own rule; `404` is not the not-found signal (unknown indicators return `200` with `count == 0`); and OTX's IP guard is weaker than ours, so `app/core/security.py` remains the pre-flight control.

**The history sources, and what research changed**

- **HIBP — removed, never activated.** The integration was built and tested, then deleted on request before any push. It required a **paid subscription plus domain-ownership verification**, with no free substitute, so it could never do anything until a budget decision was made; code that cannot be active is worse than absent, because an empty card implies a capability the deployment does not have. The module, its tests, the orchestrator/config/router wiring, `HIBP_API_KEY`, `SCAN_TIMEOUT_HIBP`, and its documentation rows are all gone, and the item stays open in TODO.md with the reason recorded.

- **Leak-Lookup** — the TODO's "public, no key" is **wrong**: the API requires a key. Free tier is 10 queries/day, and the ToS restricts queries to targets the operator is authorised to search, so wiring it to arbitrary signed-in users is an operator decision; it defaults off. Its payload is the most dangerous handled here (email + password pairs), so rows are counted without ever being read and the error path is scrubbed too.
- **URLScan.io** — search needs no key (verified against the live API). Free tier measured, not assumed: history capped at **30 days**, `size` silently clamped to 100, 30 req/min/IP, verdicts paywalled. Nothing may promise "full history". Only verdict, task UUID and page URL are kept.
- **Defacement — dropped, replaced by OTX.** The TODO's suspicion was **worse than stated**: Zone-H is alive but `api.zone-h.org` is NXDOMAIN, the archive is anti-bot, the general RSS was **withdrawn by the operator** for abuse, and the surviving special RSS has no per-domain query, carries **no banner at all**, and is **CC BY-NC-ND** (non-commercial, no-derivatives) — unusable here. `defacement_service` and its `ZONEH_*` settings are gone.
- **VirusTotal — not integrated, deliberately.** Its free Public API is barred from commercial products, stated three times in VT's own docs with "immediate permanent ban" as the penalty, and querying an indicator publishes it to the VT community dataset. Licensing gate, not a rate-limit gate. `VIRUSTOTAL_API_KEY` stays a BYOK setting for operators who supply their own key.
- **Censys — not integrated.** A separate paid key, and Shodan already covers exposed services, infrastructure and banners here.
- **Live screenshot** — resolved through the cheap alternative the TODO itself suggested: URLScan's **passive** screenshot URL, verified live. No headless browser, no browser image in the container, no execution of attacker-controlled JavaScript. Headless rendering remains unbuilt and still needs its own decision.

**Also fixed**: `sanitize_error` moved to `app/core/errors.py`, because `urlscan_service` importing it from the orchestrator was a circular import that failed at collection once the orchestrator began importing the history sources. A leaked respx route registered outside `respx.mock` was polluting later test files; `test_single_resolve.py` now whitelists `core/ssrf.py` with a written justification (`getaddrinfo`, not `gethostbyname`, is required to see AAAA records — the IPv4-only call would hide an AAAA pointing at loopback).

**Not done, deliberately**: the 5 deploy-readiness items need credentials and accounts (secrets provider, a managed DB, an actual deploy, branch protection, prod E2E), so they stay unticked — no CHANGELOG claim about a deployment. The Better Auth sign-up bucket limitation is unchanged and still mitigable only by keeping sign-up closed or allowlisted.

## 2026-10-07 — Pre-deployment security review closed: async DNS, resolved-IP validation, sign-up gate, bucket sweep, SQLi control

Closes every item the "Security review pra-deploy publik" pass raised. That review ran against the code itself, after the P1–P3 deploy-readiness blockers were closed. Three P1 items are fixed; the four P2 items are fixed or recorded as explicit known limitations. The four follow-up items it filed under "Residual" shipped in the same push and are written up in the next section — three closed, one still open.

**P1 — blocking DNS on the async path**

`socket.gethostbyname` ran inside `async def` in `shodan_service`, which breaks AGENTS.md §3 and is a cheap DoS: a domain with a slow resolver stalls every other request on that worker, not just its own. Moved to `core/security.py:resolve_target_ip` as `asyncio.to_thread` under `wait_for(SCAN_TIMEOUT_SHODAN)`, matching how `whois_service` already did it. `wait_for` releases the caller on time; the stuck thread itself is not cancellable and drains on its own. Resolver failure and timeout both surface as `RuntimeError`, keeping the DNS wording callers already expected.

**P1 — target validation never reached the IP a hostname points at**

`assert_target_allowed` only inspected the string and returned `False` for a non-IP without resolving, so a public-looking name pointing at `127.0.0.1` or `169.254.169.254` was forwarded to Shodan. Blast radius is bounded — Shodan is an external service and the backend never connects to the internal host — but the resolver had no turnaround bound, which also made the scan endpoint a DNS oracle for enumerating internal names.

The check lands in `routers/scan.py:assert_resolved_target_allowed`, not in a service, for a structural reason: `orchestrator.fold` turns every service exception into `errors[]` with HTTP 200, so an `HTTPException` raised inside a source service could never reach the client. It runs deliberately **after** `check_rate_limit`, because it costs a DNS query; the cheap string check still runs before the limiter, so the ordering does not become a free oracle. `shodan_service` also calls `assert_target_allowed(resolved_ip)` as the point that guarantees zero Shodan requests for an unvalidated address. Regression coverage: a domain resolving to a blocked IP is refused with 400 rather than forwarded.

**P1 — self-service sign-up was a cost vector, and the review's open question is answered**

The backend quota is per user, so N self-service accounts meant N × quota scans per hour against one paid Shodan key. The review deliberately left "does Better Auth already rate-limit this?" marked unverified rather than guessing in either direction. It is now verified against the installed `better-auth@1.7.7` — full reading in the next section: the limiter keys on `ip|path`, **not** per user, so it does not touch the cost vector at all, and `requireEmailVerification` would have been the wrong remedy, because no mail transport is configured in this repo, so Better Auth would write the user row and then fail closed at sign-in and leave accounts that can never log in.

Shipped instead, in `frontend/lib/signup-gate.ts` and wired through `lib/auth.ts`: `SIGNUP_ENABLED` (master switch; unset = closed under `NODE_ENV=production`, and an unparseable value counts as unset, so a forgotten deploy fails closed) and `SIGNUP_EMAIL_ALLOWLIST` (accepts `user@example.com`, `@example.com`, `*@example.com`, or a bare domain). Enforcement is in `databaseHooks.user.create.before`, chosen over `disableSignUp` alone because it is the one choke point Better Auth also runs for OAuth account creation — `disableSignUp` closes only the email endpoint and would leave "Continue with Google" open. Returning `false` aborts the insert before any row exists. Operator steps in WORKFLOW.md §8.3, and the policy module is deliberately dependency-free and synchronous so it is testable without a database, session, or network.

**P2 — rate-limiter buckets were never evicted**

`_buckets` is keyed per user and only pruned when *that same user* returned, so a user who scanned once and never came back leaked its key for the life of the process — unbounded growth for the container's whole lifetime, not theoretical once sign-up is open. Fixed with an amortized sweep every 300s inside `check_rate_limit`: one O(#keys) pass per interval instead of one per request, evicting only buckets whose *newest* stamp already fell out of the window, so one live stamp keeps its bucket and its remaining quota. `max(stamps)` rather than `stamps[-1]` because a backwards clock jump can leave the list unsorted, and wall-clock time rather than monotonic so the sweep guard ages exactly like the stamps it prunes. The bound this gives is "keys touched in the last ~65 minutes", not an absolute size — that is the separate `RATE_LIMIT_MAX_KEYS` ceiling in the next section.

**P2 — three items resolved as documentation, not code**

None of these was a misconfiguration. Each is now stated as a *Known limitation* so it cannot later be counted as a control that exists:
- CSP is report-only, so XSS enforcement is absent (ARCHITECTURE.md §6) — the other headers shipped in the same block (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, HSTS) *are* enforced.
- `alembic upgrade head` runs in the container CMD (ARCHITECTURE.md §8) — correct for one replica, racy on scale-out, and it duplicates release step WORKFLOW.md §8.2 step 2.
- Every `SERVICE_TOKEN` maps to `user:service`, so all machine-to-machine scans share one owner, one history row per target, and one rate-limit bucket (ARCHITECTURE.md §6).

**SQLi suite sensitivity control** (shipped in this push, previously unrecorded)

`backend/scripts/sqli_control_probe.py` exists because a green suite proves nothing until it has been shown to go red against a broken build. It copies the source tree to a temp directory, breaks one defense layer at a time, re-runs the pinned test, and refuses to count a crash as detection: a mutated build that dies on `NameError` or `SyntaxError` never executed an injectable query, so it is reported `INVALID`, not `CAUGHT`. Three mutations are covered — the ORM comparison in `routers/scan.py` turned into string-concatenated `text()`, the SQLite cache key turned into an f-string, and the asyncpg cache key turned into an inlined literal.

Gates run in this session: backend `pytest` **285 passed** + `ruff` clean + `black --check` clean (50 files) · frontend `npm test` **108 passed** + `npm run lint` clean + `npm run tsc --noEmit` clean + `npm run build` succeeded (9 routes) + `npm audit` **0 vulnerabilities** · the SQLi control probe itself: baseline `tests/test_sqli.py` **151 passed**, and all three mutations reported `CAUGHT` — `CONTROL PASSED`. The ORM mutation is caught as 60 database errors (the injected SQL reached the driver), the two cache mutations as 10 and 30 assertion failures (the payload was observed as data).

Secret grep over `origin/main..HEAD` is clean: the only matches are placeholders, doc snippets, and test fixtures (`<password>`, `pick-any-local-password`, `your-own-password-here`, `s3cr3t-shared-value-32chars!!-extra`).

Not run in this session: nothing was deployed and no live Shodan scan was made, and this entry was written before the push, so the three `ci.yml` jobs have still never executed. The five "Deploy readiness" items and the one open residual item (Better Auth's shared `/sign-up` bucket on Vercel) are untouched here and stay open in TODO.md.

## 2026-10-07 — Security review residual: scan-quota budget, bucket ceilings, single DNS resolve, Better Auth sign-up bucket verified

Closes three of the four items under "Residual dari security review" in TODO.md. The fourth is verified and partially mitigated, with its residual stated rather than closed. — **swept 2026-10-07**: the three closed items were removed from TODO.md by the push that shipped them (AGENTS.md §9), so that section now tracks only the still-open fourth item.

**Scan quota for a public domain** (TODO residual #1)

- `rate_limit_per_hour` default `10 → 5`, and `PRODUCTION_RATE_LIMIT_CEILING = 5` is now a module constant in `app/core/config.py` with the billing reasoning in the comment. At 5/hour one account draws at most ~3.6k Shodan queries per 30-day month; at the old 10 it could draw ~7.2k on its own, and that scales with account count.
- **Production refuses to boot** unless `RATE_LIMIT_PER_HOUR` is present, a whole number, ≥1, and ≤ the ceiling — same fail-closed shape as the existing secret / CORS / `sslmode=require` guards. Presence is checked via `os.getenv`, not the field value, because a Pydantic default cannot distinguish "unset" from "deliberately 5" and an unset quota on a paid key is a silent budget decision. Documented consequence: it must be a real environment variable, not only a `.env` file inside the image (WORKFLOW.md §8.4).
- `RATE_LIMIT_DAILY_TOTAL` (default `0`, disabled): opt-in instance-wide ceiling on *admitted* scans per rolling 24h, counted in hourly buckets so the counter stays at ≤25 entries. Exists because a per-account quota cannot express a budget for the shared key. Ships disabled because the right number is a billing decision, and guessed in either direction it either breaks paying users or spends money quietly.
- **Account-age quota weighting (option b) evaluated and rejected, not skipped.** The limiter receives the opaque `user:<id>` string with no DB session, so weighting needs an awaitable query on the hot path of every scan inside a module that is currently synchronous and dependency-free — and it would fail open exactly when the database is down. The daily cap covers the same blast-radius concern without the per-request cost.

**Absolute ceiling on `_buckets`** (TODO residual #3)

`RATE_LIMIT_MAX_KEYS` (default 10000). At the cap, an *unknown* key is refused with 429 until the next sweep. **Fail closed, deliberately:** LRU eviction would hand a live user back their remaining quota, so anyone able to mint keys could mint free scans on a paid key — and since the sweep orders by newest stamp, the flood victims are exactly the newest keys, i.e. active users. Fail-closed costs at most one sweep interval of new signups and cannot touch an existing bucket. The 429 body is byte-identical to a quota rejection on purpose; a distinct message would be a probe for how full the map is.

**One DNS resolution per scan** (TODO residual #4)

`assert_resolved_target_allowed` now returns the resolved IP, threaded as a keyword-only `resolved_ip` through `orchestrator.run_scan` → `gather_results` → `shodan_service.lookup`. Hostname scans go from two resolutions to one. Two decisions worth recording: a failed pre-flight forwards `None` so the service resolves for itself (otherwise a transient resolver blip becomes a permanent Shodan error), and an IP literal returns `None` because `_is_ip` already bypasses the resolver. `assert_target_allowed(ip)` now runs on **every** path rather than only the hostname branch, so a caller-supplied `resolved_ip` nobody validated still costs zero Shodan requests. Two resolutions remain only when pre-flight itself fails — both attempts failing, deliberately. Cache keys unchanged, and a Shodan cache hit still makes no service-side resolve because the kwarg is read inside the job body, not when building it.

**Better Auth sign-up bucket: claim confirmed, residual open** (TODO residual #2)

Verified against installed `better-auth@1.7.7` rather than assumed: `getIPFromHeader` returns `null` for a multi-hop `x-forwarded-for` with no `trustedProxies` (`@better-auth/core/dist/utils/ip.mjs:190`), production has no localhost fallback (`:217-218`), `null` becomes the literal key `no-trusted-ip` (`rate-limiter/index.mjs:236,248`), and `/sign-up*` is capped at 3 requests / 10s (`:305-312`). Every sign-up therefore shares one bucket — abuse self-limits, and one attacker can exhaust everyone's sign-up quota.

Partially mitigated by `BETTER_AUTH_TRUSTED_PROXIES` (default empty) whose parser is stricter than Better Auth's: `0.0.0.0/0`, `::/0`, and bare `0.0.0.0` are rejected, because they make the limiter trust the client-supplied leftmost token and match every address. A test asserts anything we accept Better Auth also accepts.

**Not closed:** on Vercel this knob will typically stay empty, since Vercel publishes no edge ingress ranges, so the shared bucket persists there. Header reordering does not help (`x-real-ip` is documented as identical to `x-forwarded-for`), and `rateLimit.customRules` cannot re-key — the key is computed before rules resolve, and a rule can only narrow or widen. The practical mitigation is leaving sign-up closed or allowlisted (WORKFLOW.md §8.3); closing it properly needs a limiter outside Better Auth (v2). Pinned by `frontend/lib/auth-rate-limit.test.ts`, which imports the real installed helpers so an upgrade that changes the fallback, key, or 3/10s rule fails the suite instead of regressing silently.

Gates run in this session: backend `pytest` **285 passed** + `ruff` clean + `black --check` clean (50 files) · frontend `npm test` **108 passed** + `npm run lint` clean + `npm run tsc` clean + `npm run build` succeeded. Docs synced for the changed default: `WORKFLOW.md` §8.4 (new) and §8.5 (new), §8.3, §8.2 step 4, the §8 env list, `ARCHITECTURE.md` §6, `backend/.env.example`, `frontend/lib/signup-gate.ts`.

One agent run of `pytest` hit a 600s timeout mid-task; the cause was three agents running gates concurrently, not a regression — a clean re-run finished in 16s and every subsequent run has been green.

**Still open, not addressed here:** the five "Deploy readiness" items need real infrastructure (managed DB, secrets provider, GitHub branch protection, a production domain). No `gh` CLI and no `GITHUB_TOKEN` in this environment, so branch protection is not actionable from here.

## 2026-10-07 — Deploy readiness: boot blockers, live CI, Vercel disclosure

Closes all P1–P3 items from "Deploy readiness" in TODO.md. Target topology documented as **Vercel (frontend) + container (backend)**; nothing is deployed yet.

**P1 — app gagal start**

- **`.env.example` driver URL**: `postgresql://` → `postgresql+asyncpg://`. The backend opens the DB with `create_async_engine()` (`app/db/session.py`) and `psycopg` is not in `requirements.txt`, so a copied-as-is env file died at boot with `ModuleNotFoundError: No module named 'psycopg'`. Three comment lines added explaining why, so it does not get reverted. `AGENTS.md` (which carried the same wrong scheme in its DB snippet) resynced.
- **Alembic fallback credentials**: `osint:osint` → `owner:owner` in `backend/alembic/env.py`, matching `${POSTGRES_USER:-owner}` / `${POSTGRES_DB:-osint}` in `docker-compose.yml`. Previously a container starting without `DATABASE_URL` failed migration auth.
- **Regression test** `backend/tests/test_config.py` (new, 4 tests): the example URL is engine-constructible, its scheme is `postgresql+asyncpg`, and its user/db match `docker-compose.yml`; the Alembic fallback is held to the same contract; and plain `postgresql://` is asserted to actually fail (`ModuleNotFoundError`), which pins the reason for the fix instead of just the symptom. Backend `pytest` 78 → 82.

**P1b — onboarding hole found while closing P1**

`docker-compose.yml` requires `POSTGRES_PASSWORD` with no default (`:?` → hard fail), but neither quickstart ever mentioned it, so `docker compose up -d postgres` failed for anyone following the docs literally. `README.md` and `WORKFLOW.md` §2 now set it first and use one password in both `DATABASE_URL` values.

**P2 — CI is now tracked and runs**

- `.github` removed from `.gitignore`; `git check-ignore` exits 1 and `.github/workflows/ci.yml` is tracked.
- New `Audit backend dependencies` step: `pip-audit --require-hashes --disable-pip` over both `requirements.txt` and `requirements-dev.txt`. Chosen over `uv pip compile --check` because that flag does not exist on `uv pip compile`; `--require-hashes` gives the stronger property here — the step fails closed if any compiled entry ever loses its pin or hash — and `--disable-pip` audits the exact pinned set without re-resolving against the live index.
- New `secrets` job: gitleaks 8.30.1 as a SHA256-verified pinned binary (the official action needs `GITLEAKS_LICENSE` and `pull-requests: write`, which conflicts with `contents: read` and no-token). `--redact`, range `base..HEAD` on PRs and `before..HEAD` on pushes, `--all` for a new branch, no SARIF upload. The allowlist is one narrow regex for committed env *templates* only — required, because `backend/.env.example` otherwise trips `generic-api-key` on an empty `NVD_API_KEY` line; real `.env` files stay fully scanned. Verified with positive and negative controls (full history clean, injected `ghp_…` PAT caught).
- **First-party actions bumped to Node 24 majors**: `checkout@v4`→`@v6`, `setup-python@v5`→`@v6`, `setup-node@v4`→`@v6`. GitHub removed Node 20 from runners on 2026-09-23 and the `ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION` opt-out went with it, so `@v4`/`@v5` still declare `runs.using: node20`. `node-version: 20` (the project's own Node) is deliberately unchanged — that is a different thing from the action runtime and stays consistent with the documented "Node ≥20" prerequisite. **Reversed 2026-10-09:** the project's own Node was raised to 22, because a Node floor of 20 cannot run this repo's test suite — see the 2026-10-09 entry.
- `WORKFLOW.md` §6: the note claiming `.github/` is intentionally git-ignored is gone, replaced by the gate list read from `ci.yml` plus branch-protection instructions.

**P3 — Vercel disclosure**

- `frontend/vercel.json` (new): `framework: "nextjs"` + `$schema`. Deliberately no `regions` — nothing in the repo fixes where the database or backend runs, so pinning one would be a guess that then constrains every function. No in-file comments: the Vercel CLI parses strict JSON and `//` would break the deploy, so the reasoning lives in `WORKFLOW.md` §8. **Correction (2026-10-09): this file was not actually committed on that push — it was absent from the tree and has been recreated.** See the 2026-10-09 entry; the content is as described here.
- **Connection pooler requirement documented** (`WORKFLOW.md` §8.1): `lib/auth.ts:42` uses `new Pool({ connectionString })` from `pg`, a direct TCP connection. Short-lived horizontally-scaled serverless instances each open their own connection and will exhaust the database's slots, hanging sign-in and session reads. Production `DATABASE_URL` must be a pooled endpoint (Supabase pooler / Neon pooled / PgBouncer), with TLS still required.
- **Deploy runbook** (`WORKFLOW.md` §8.2): 6 ordered steps — database + pooled URL → `alembic upgrade head` → `npm run auth:migrate` (reads `frontend/.env.local`, so it must not run inside the Vercel build) → only then set `BETTER_AUTH_URL` / `NEXT_PUBLIC_APP_URL` / `CORS_ORIGINS` / `APP_URL` → deploy backend then frontend → verify signup/scan/sign-out on the production domain.

**Not run in this session:** no GitHub Actions execution happened (no push), so the three jobs are verified by YAML parse and by running each step's logic locally — the gitleaks and pip-audit steps were exercised against the real files, but CI itself has never been green yet.

Gates run locally in this session: backend `pytest` **82 passed** + `ruff` clean + `black --check` clean (46 files) · frontend `npm test` **70 passed** + `npm run lint` clean + `npm run tsc` clean + `npm run build` succeeded (9 routes) · `npm audit` **0 vulnerabilities**.

Follow-up review of the same code found three public-exposure blockers (blocking DNS in the async path, target validation not applied to resolved IPs, ungated sign-up). Those are open work in TODO.md, not part of this entry. — **superseded 2026-10-07**: all three were closed in the entries above, and the review section they lived in was swept out of TODO.md by that push.

## 2026-10-06 — Security hardening (pre-deployment audit P1 + P2 done)

All 12 items under "Security hardening" in TODO.md resolved:

- **Pinned backend deps**: new `backend/requirements.in` / `requirements-dev.in`, compiled to pinned + hashed `requirements.txt` (runtime) / `requirements-dev.txt` (dev tooling) via `uv pip compile --generate-hashes`; Dockerfile installs runtime-only with `--require-hashes`
- **Non-root container**: `USER app` with chowned `/srv/app` (+ `data/` for the SQLite cache)
- **npm audit**: `source-map-js` fixed → `npm audit` reports **0 vulnerabilities**
- **Docs off in prod**: `docs_url`/`redoc_url`/`openapi_url` = `None` when `APP_ENV/NODE_ENV=production`
- **CORS guard**: production raises if `CORS_ORIGINS` contains `*` (would reflect any origin with `allow_credentials=True`)
- **CSP + HSTS**: `Content-Security-Policy-Report-Only` (with `sha256-` hash of the inline theme script in `app/layout.tsx`) + `Strict-Transport-Security`; enforcement still needs a nonce for Next.js hydration scripts. The declared hash had gone stale against the current theme script (harmless while Report-Only, but it would have blocked the script the moment CSP is enforced) — recomputed, and `lib/security-headers.test.ts` now fails if the hash, the Report-Only status, the baseline headers, or the locked-down directives drift.
- **Service token split**: new `SERVICE_TOKEN` env for `Authorization: Bearer` machine access; `BETTER_AUTH_SECRET` is no longer accepted as an API key, and Bearer fails closed when the token is unset (breaks the old `Bearer <BETTER_AUTH_SECRET>` flow — rotate to `SERVICE_TOKEN`)
- **Compose**: `version:` dropped, Postgres now bound to `127.0.0.1:5432` with a note that prod uses internal-only networking
- **Rate limit**: documented in ARCHITECTURE.md §6 as a per-process in-memory limitation (resets on restart, × worker count; single worker in prod or Redis/Postgres in v2)
- **`/ready`**: returns plain `degraded` in production; exception class name only in dev
- **CI gates**: required-check list (npm audit, pip-audit/`uv pip compile --check`, lint/tsc/test/build, secret scan) documented in WORKFLOW.md §6 for when `.github/` is re-enabled — **superseded 2026-10-07**: `.github/` is now tracked and these gates are live jobs in `ci.yml`, not a documented intention. The `uv pip compile --check` suggestion was replaced by `pip-audit --require-hashes --disable-pip`.
- **TLS**: production `Settings` rejects non-localhost Postgres URLs without `sslmode=require`; Next middleware returns 503 when `BETTER_AUTH_URL` is non-localhost http in production
- Env plumbing: `SERVICE_TOKEN` added to `backend/.env.example` + WORKFLOW.md (§2 install now uses `requirements-dev.txt`); ARCHITECTURE.md §6 session/proxy wording corrected

Gates: `pytest` 78 passed + `ruff`/`black` clean; `npm test` 70 passed + `lint`/`tsc`/`audit`/`build` clean.

## 2026-10-06 — Docs consolidation

- README rewritten: one quickstart; duplicated troubleshooting/env/test-score sections replaced with links to WORKFLOW.md
- MANUAL-SETUP.md dissolved: setup steps → WORKFLOW.md, open external actions → TODO.md
- TODO history archived in this file; PRD marked implemented; AGENTS commands corrected (pnpm → npm)
- `.github` remained git-ignored here (owner request 2026-10-06) — the local CI workflow was not shipped; **reversed 2026-10-07**, the workflow is now tracked and running. MIT LICENSE added

## Phase 17 — CVE Validity Tiers [DONE 2026-10-05: BE 74 passed + ruff/black clean, FE 60 passed + tsc/lint clean]
Tujuan: tiap baris CVE bisa diaudit (ID → severity/CVSS → CPE bukti → alasan cocok).
Konteks: `45.33.32.156` balikin 113 vuln InternetDB tapi CPE-nya format `cpe:/...`
kebuang filter `cpe:2.3:`, sehingga NVD tidak jalan dan kartu tampil
"NVD enrichment did not run".

- [x] `shodan_service.py`: terima + normalisasi CPE 2.2 → 2.3
  (`cpe:/a:vendor:product:version` → `cpe:2.3:a:vendor:product:version:*:*:*:*:*:*:*`);
  mapping deterministik 1-ke-1, bukan keyword guessing; `cpe:/o:...` ikut dikonversi
- [x] `nvd_service.py`: verifikasi silang per-ID Shodan × NVD (`cveId` lookup,
  cap 20 CVE/scan, cache 7 hari); tier per baris:
  `verified` (NVD ada + cocok CPE) / `unverified` (ID valid tapi tak cocok CPE
  atau belum diverifikasi karena cap/NVD mati) / `rejected` (NVD `vulnStatus`
  Rejected/Disputed → tampil tapi tidak dihitung skor)
- [x] `orchestrator.py`: tanpa hapus fallback (crt.sh/Cert Spotter/Subfinder tetap);
  NVD gagal total → semua baris Shodan tier `unverified`, bukan hilang
- [x] `risk.py`: skor hanya dari `verified` + `unverified`; `rejected` dikeluarkan;
  pertahankan flag `vulns_incomplete`
- [x] `VulnerabilitiesCard.tsx`: kolom CVE (link `nvd.nist.gov/vuln/detail/...`) +
  tier badge + severity + CVSS + evidence CPE + sumber (Shodan/NVD);
  daftar Shodan tetap tampil dengan label `unverified`
- [x] Tests: `test_nvd_service.py` (konversi CPE 2.2, tier verified/unverified/
  rejected, cap 20, cache) + `components.test.ts` (tier badge + link NVD);
  gates `pytest`/`ruff`/`black` + `npm test`/`tsc`/`lint` hijau
- [x] Docs: `ARCHITECTURE.md` (kontrak tier) — tanpa kredensial baru

## Phase 16 — NVD CVE Enrichment [DONE 2026-10-05]
- [x] `shodan_service.py`: preserve valid `cpe:2.3:` identifiers from Shodan host (`data[].cpe`) and InternetDB (`cpes`); reject keyword/product matching
- [x] `nvd_service.py`: exact `cpeName` query (never `isVulnerable` — verified unstable 2026-10-05: 83 mentions without flag, bare 404 with flag for Apache 2.4.49 fixture); client-side filter to `vulnerable=true` + version-range match; statuses `found/no_match/insufficient_evidence/unavailable`; per-CPE cache 7d; sequential rate-limit delay
- [x] `orchestrator.py`: enrich after Shodan (only when CPE evidence exists — no network on pure cache hit); NVD failure → `results.nvd.status=unavailable` + `errors[]`, never 500
- [x] `risk.py`: evidence set = `shodan.vulns` + `nvd.cves` (dedupe); missing NVD coverage flags `vulns_incomplete`, never reads as zero
- [x] Frontend: `lib/api.ts` NVD types + `lib/scan-shape.ts:getCveEvidence()` (missing data renders `—`, not `0`); `OverviewCards.tsx` + `app-1-data.ts` use evidence count + hint
- [x] `VulnerabilitiesCard.tsx`: CVE list (ID + severity + CVSS + evidence CPE) with `Skeleton`/error/empty states + "no match is not proof of safety" disclaimer; wired into `dashboard/page.tsx` after `PortsTable`
- [x] Tests: `backend/tests/test_nvd_service.py` (9 tests: exact match, non-vulnerable filtered, version-range, 404→no_match, timeout→unavailable, invalid CPE rejected, 429, caps, risk merge) + orchestrator NVD-partial test + `scan-shape.test.ts:getCveEvidence` (4 cases); fixed 3 pre-existing `test_orchestrator.py` live-network leaks (Cert Spotter mock)
- [x] Docs/env: `ARCHITECTURE.md` contract (`results.nvd`) + `backend/.env.example` (`NVD_API_KEY`, `SCAN_TIMEOUT_NVD`, `NVD_MAX_CPES`, `NVD_CVES_PER_CPE`, `NVD_PAGE_SIZE`)
- [x] Gates: backend `pytest` 67 passed + `ruff` clean + `black` clean; frontend `npm test` 58 passed + `tsc` clean + `eslint` clean; secret grep clean in diff (only `.env.example` key name + test fixture strings); no `dangerouslySetInnerHTML`/`javascript:` in diff

## Current verified status (2026-10-04)

### Completed and validated
- [x] Better Auth email/password and configurable Google/GitHub providers are wired to PostgreSQL, with a real Next API handler.
- [x] Backend verifies Better Auth cookie tokens against active database sessions; arbitrary, expired, and unsigned fake cookies do not authenticate.
- [x] Production rejects default/placeholder Better Auth secrets.
- [x] History, trend, and scan detail queries are scoped to the authenticated owner; cross-user scan access returns 404.
- [x] Separate sign-in/sign-up flows use Better Auth client APIs; signup validates email, password length, and confirmation.
- [x] `/dashboard` middleware validates via Better Auth `get-session`; removed the synthetic `/dev-login` route and its auto-login path.
- [x] Backend validates Better Auth HMAC-signed session cookies against active PostgreSQL sessions; verified with a local live signup and protected scan.
- [x] Risk logic no longer uses a fake zero-value TLS placeholder; expiry-based signal is used instead.
- [x] Landing placeholder visuals and fake sample-data scaffolding were removed from the live UI.
- [x] Implemented bounded Subfinder fallback for crt.sh failures; it preserves the crt.sh error, validates/deduplicates/caps results, and reports missing binary, process failure, timeout, or excess output. Host runtime and Docker image Subfinder v2.16.0 verified. Focused backend tests, Ruff, and Black passed.
- [x] Upgraded Next.js to patched 15.5.27, updated dynamic route params, and pinned transitive PostCSS to 8.5.28. Frontend tests (53), TypeScript, and production build pass; `npm audit --omit=dev` reports 0 vulnerabilities.
- [x] Generated and reviewed frontend license metadata via npm SBOM; `caniuse-lite` is identified as CC-BY-4.0 and needs maintainer acceptance or replacement.
- [x] Verified Better Auth tables and the local signup → session → protected scan → sign-out/revocation flow against shared PostgreSQL. The scan returned HTTP 200/partial, sign-out returned 200, the revoked session returned 401, and the synthetic test account/scan were cleaned up.
- [x] Verify Google/GitHub login: user confirmed both providers are working (2026-10-04).
- [x] Re-run post-change gates (2026-10-04): fallback-focused backend tests (31), security tests (10), Ruff, and Black passed; frontend TypeScript, 53 tests, and Next.js 15.5.27 production build passed. Production dependency audit is clean.

### Remaining blockers (not fabricated, not silently omitted)
- [x] Add and verify the backend's initial Alembic revision. Fresh PostgreSQL upgrade and schema drift check passed; the existing local application schema was matched and stamped without changing application data. Alembic excludes the Better Auth-owned tables in the shared database.
- [x] Google/GitHub login verified by user report (2026-10-04).
- [x] Add GitHub Actions CI for PostgreSQL migrations, backend tests/style, frontend lint/type/tests/build, and dependency audit.
- [x] Complete maintainer license review for the `caniuse-lite` CC-BY-4.0 dependency.
- [x] Run full Git history and current-source secret scans with redacted Gitleaks v8.24.3 reports: 42 commits scanned, no leaks in history or current source (2026-10-04). Local `.env` files were excluded from the source scan and are ignored by Git.
- [x] Migrated the frontend to Tailwind CSS 4.3.3, moved the existing theme tokens to CSS-first configuration, and removed obsolete Tailwind 3 config/dependencies. Frontend TypeScript, all 53 tests, production build, and full `npm audit` pass (0 vulnerabilities).
- [x] Run clean-room pre-push validation without local `.env` files: frontend `npm ci`, lint, 53 tests, TypeScript, audit (0 vulnerabilities), and production build passed; backend ran in the Python 3.11 image with 49 tests, Ruff, targeted Black, fresh PostgreSQL migration/drift check, and Subfinder smoke test (2026-10-04).

### Newly reported issues and requests (2026-10-04; investigated and/or resolved as applicable)
- [x] Diagnose the reported Shodan error for `162.159.138.232` (HTTP 403: no host data or plan limit); the backend now raises a friendly CDN/WAF/plan-limit message and strips any API-key leakage. Covered by [backend/app/services/shodan_service.py](./backend/app/services/shodan_service.py) and [backend/tests/test_failure_modes.py](./backend/tests/test_failure_modes.py).
- [x] Diagnose the crt.sh timeout reported at about 15 seconds; the behavior is reconciled with the 30s source timeout and the retry/backoff logic keeps failures partial instead of 500s. Covered by [backend/app/services/crtsh_service.py](./backend/app/services/crtsh_service.py) and [backend/tests/test_failure_modes.py](./backend/tests/test_failure_modes.py).
- [x] Diagnose Subfinder `NotImplementedError` from scan `fb852eba-4ce2-479f-8c27-47961b93d1953`; the fallback now normalizes unsupported-runtime exceptions into a safe user-facing runtime error and preserves the original error cause internally. Regression coverage is in [backend/tests/test_subfinder_service.py](./backend/tests/test_subfinder_service.py).
- [x] Investigate the two reported backend CI errors; fixed the Windows-only pytest temp-directory issue by pinning pytest to a repo-local base temp/cache directory in [backend/pytest.ini](./backend/pytest.ini). This avoids `PermissionError` under `AppData\Local\Temp`.
- [x] Use `/find skills` and add restrained looping decorative/background animation or motion across the requested pages to make the UI feel less flat. Keep scan data and primary actions stationary, support reduced motion, and verify mobile performance. — done 2026-10-06, scope approved and expanded across two follow-up passes; see the `AmbientBackdrop` / `ScrollProgress` / `ParallaxField` / `BentoVisuals` / `RiskMeter` entries under Phase 8 and the looping passes below
- [x] Change the database password to the value requested by the user; store it only in local/deployment secret configuration, never in the repository. (external secret/config action; not a repo change)

## Phase 15 — Dashboard Layout + Hover Palette + discord.com Errors [DONE 2026-10-01]

- [x] Layout: `app-shell.tsx` jadi shell murni (sidebar + header + slot); `page.tsx` pegang urutan search → stats → charts 2-col → ports full → subdomains/WHOIS 2-col → history/findings 2-col; semua kartu `CardHeader+CardContent`; chart `h-[240px]` + `maintainAspectRatio:false`; tabel `max-h-[320px]` scroll; satu history (`HistoryList` limit 5, row badge + progress); `PortsChartInner` grup per product top-8. Kontrak: order + card-structure + locked-height di `dashboard.test.ts`
- [x] Palet (Emerald dipertajam): token baru `--accent-hover` (dark `160 84% 55%` / light `160 100% 28%`) + tailwind `accent-hover`; semua hover netral (`slate-100/200`, `neutral-700/800`, `input`, `opacity-90`) → `hover:bg-accent-hover` / `hover:bg-accent/10` + `hover:border-accent/40` / `hover:text-accent` di button, sidebar, tabel, history, landing Nav/Hero/Cta; chart hover `accentHover/accentBarHover`. Kontrak di `palette.test.ts`; DESIGN.md Colors/Hover/Layout diperbarui
- [x] Backend discord.com: Shodan 403 (IP Cloudflare tanpa data) → pesan ramah "likely CDN/WAF IP" (401/404 dipetakan juga); `sanitize_error()` di orchestrator strip `?key=…` agar API key tak bocor via `errors[]`; crt.sh retry 3x backoff + timeout 15→30s + pesan "large zone — retry with Re-scan"; `_with_timeout` tak lagi hasilkan `TimeoutError:` kosong. Test baru: 403-tanpa-key-leak, sanitize-strip-key, crtsh-retry (BE 33 passed; 2 error tmp Windows adl env-only yang sudah dikenal)
- [x] Follow-up crt.sh 502 (skills.sh, 2026-10-01): 502 ternyata outage crt.sh-wide (example.com ikut 502) — retry diperluas ke 502/503/504 + pesan "temporarily unavailable, retry with Re-scan"; test 502-recover + 502-persistent. Scan tetap `partial` (Shodan/WHOIS tampil)
- [x] Verifikasi: BE `pytest` 30 passed (scope C) + `ruff`/`black` bersih di file tersentuh; FE `npm test` 50 passed, `tsc` bersih, `next build` OK; grep hover-netral 0 + hex hanya CDN

## Phase 14 — Dev Startup Fix (Windows + OneDrive) [DONE 2026-10-01: `next dev` + `next build` verified, 48 tests pass, tsc clean]

- [x] Akar masalah "tidak mau di start": repo di bawah `OneDrive\Documents` → "Files On-Demand" mengubah isi `.next` jadi placeholder (reparse point); saat boot Next memanggil `readlink` di `recursive-delete` → `EINVAL` → `next dev`/`next build` crash sebelum Ready.
- [x] Fix: `frontend/scripts/clean-next.mjs` (Node `rmSync`, toleran reparse point) + hook `predev`/`prebuild` + `npm run clean`; hanya aktif di Windows saat path mengandung "onedrive" (override `FORCE_CLEAN_NEXT=1`), jadi setup lain tak kehilangan cache. Terverifikasi: start ulang dengan `.next` sudah ada → `✓ Ready` + `GET / 200`, tanpa EINVAL. Catatan env: `pnpm` tidak terpasang (ada `corepack`), pakai `npm`.

## Phase 13 — Terminal Clear Transition [DONE 2026-10-01: npm test 48 passed, tsc clean]

- [x] Sample output loop di landing tidak lagi lompat tiba-tiba: setelah output selesai, terminal mengetik `clear` lalu mengosongkan layar sebelum scan berikutnya, sehingga 3 sampel (`example.com` → `api.acme.co` → `portal.nova.io`) terbaca sebagai satu sesi shell berkelanjutan (`TerminalTyper.tsx`: state `clearChars` + konstanta `CLEAR_CMD`/`CLEAR_PAUSE_MS`/`CLEAR_BLANK_MS`; reduced-motion tetap statis). DESIGN.md Physics + Terminal diperbarui.
- [x] Animasi clear (bukan hilang polos): baris command + output keluar bertahap fade + slide-up (`AnimatePresence` exit, `CLEAR_EXIT_MS`/`CLEAR_STAGGER_S`, kaskade atas→bawah) dan teks `clear` ikut memudar; hanya `transform`/`opacity`, `prefers-reduced-motion` tetap statis.

## Phase 12 — Dashboard Parity dengan Landing [DONE: npm test 48 passed, tsc clean, `next build` OK, verifikasi browser dark+light]

- [x] Blue cast hilang: dark `--background/skeleton/input/border/muted` dinetralkan (`--background: 210 33% 6%` = `#0a0f14` persis); diverifikasi computed `rgb(10,15,20)` di landing + dashboard
- [x] Font global: Space Grotesk + JetBrains Mono pindah ke root `layout.tsx` (dashboard/sign-in sebelumnya jatuh ke system font); duplikasi di landing `page.tsx` dibuang
- [x] Button base jadi pill (`rounded-full`) seperti CTA landing; `forwardRef` tetap
- [x] Status colors ber-token: `--warning`/`--danger` light/dark; ScanStatus + TargetSearch pakai token (amber-300/red-400 polos dibuang); border tabel dipasangkan light/dark
- [x] Chart pakai warna token (`lib/chart-theme.ts`: accent dataset, grid `btn-border`, tick `muted`) + re-render saat toggle tema via MutationObserver
- [x] Kontrak: `palette.test.ts` (token warning/danger/panel, bg netral, font di root, base pill) + `dashboard.test.ts` (status token, border tabel, chart palette)
d- Catatan investigasi: kartu yang "macet gelap" saat toggle di window tersembunyi = artefak (CSS transition clock beku; body tanpa transisi flip benar, klon segar benar). Reload langsung di light: semua kartu putih, border terang, 0 animasi — kode benar.

## Phase 11 — One-Script Dev + Auto-Login [SUPERSEDED 2026-10-03]

- [x] `dev.ps1` di root: 1 perintah nyalakan backend+frontend, install otomatis yang kurang (venv/deps/node_modules), reclaim port 3000/8000, tunggu sehat, buka browser; Ctrl+C matikan dua tree; murni ASCII agar lolos parser Windows PowerShell 5.1
- [x] Historical dev-cookie helper removed when the real Better Auth DB-backed flow was added; `/dev-login` no longer exists.

## Phase 10 — Palette Token Alignment + Mobile Sheet Fix [DONE 2026-10-01: npm test 43 passed (2 baru), tsc clean, `next build` OK]

- [x] Migrasi semua `#00E59B` literal → utilitas token global (`bg-accent/text-accent/border-accent/text-accent-foreground`); hex hanya di `--accent` + URL Simple Icons; kontrak di `login.test.ts` + `palette.test.ts`
- [x] Fix sheet burger kosong di mobile (`max-md:flex` override `hidden`; sebab: `cn()` plain-join, `.hidden` menang atas `.flex` di cascade) + `Button` `forwardRef` untuk `asChild`; kontrak di `dashboard.test.ts`; terverifikasi di CSS produksi

## Phase 9 — Shared Color Palette [DONE 2026-10-01: npm test 41 passed (6 baru palette), tsc clean, `next build` OK]

- [x] Tetapkan palet sign-in sebagai acuan bersama: background dark `#0a0f14`, surface neutral gelap, accent emerald `#00E59B`, teks kontras, serta pasangan warna light yang konsisten dan mudah dibaca.
- [x] Selaraskan warna landing dan sign-in pada mode dark/light; dark tetap default dan toggle serta preferensi tema harus berperilaku sama di kedua halaman.
- [x] Dokumentasikan token palet dan aturan penggunaannya lintas tema di DESIGN.md saat pekerjaan implementasi dilakukan.
- [x] Setelah palet landing/sign-in ditetapkan, terapkan palet yang sama pada semua page, termasuk dashboard; audit background, surface, teks, border, state, dan accent.
- [x] Verifikasi kontras dark/light dan jalankan frontend tests, TypeScript, serta build setelah implementasi.
- Browser 2026-10-01: landing/sign-in/dashboard dark+light OK, Lighthouse 1.0/1.0/1.0, bukti `frontend/public/evidence/phase9-*`. Current-build 390px/1440px viewport and LCP/CLS rechecked 2026-10-04 under Phase 5.

## Phase 8 — Dashboard & Theme Follow-up [DONE 2026-09-30]

- [x] Selaraskan warna dan tampilan dashboard dengan landing page dan login.
- [x] Rapikan layout dashboard, termasuk container pada ukuran layar yang diuji.
- [x] Arahkan klik logo/monogram `N` di dashboard kembali ke landing page.
- [x] pisahkan perilaku scrolling aside dengan halaman utama agar aside tidak ikut bergulir.
- [x] Tambahkan toggle dark/light di landing dan login; dark tetap default dan preferensi tema tersimpan lintas kedua halaman. Perbarui aturan dark-only di DESIGN.md saat implementasi.
- [x] Selaraskan animasi logo berputar dengan outline-nya pada tampilan desktop fullscreen.
- [x] di landing page, bagian sample output scan hanya menggunakan example.com, buat sampel mengscan 3 website berbeda dan di looping agar tampilan website lebih menarik.
- [x] Animasi dekoratif restrained (scope B, approved 2026-10-06): `AmbientBackdrop` CSS-only (`ambient-drift`/`ambient-pulse`, `motion-safe:`) di hero + CTA band landing dan panel samping login; terminal/CTA/dashboard 100% statis; kontrak di `landing.test.ts`/`login.test.ts`/`dashboard.test.ts` (62 passed) + `tsc` + `lint` hijau.
- [x] Full ambient motion (approved 2026-10-06, scope diperluas atas permintaan user): `ScrollProgress` (progress bar nav, scaleX spring), `ParallaxField` (2 wash emerald beda kecepatan scroll di hero, decorative-only), `BentoVisuals` (grid bernapas stagger + bar metric tumbuh scaleY spring), `RiskMeter` (isi bar scaleX spring), hover micro-interaction CTA/kartu (`-translate-y` + accent shadow, `motion-reduce:` off) — semuanya transform/opacity-only + reduced-motion fallback; dashboard tetap 100% statis (kontrak test baru). Gates: `npm test` 64 passed + `tsc` + `lint` hijau.
- [x] Fix tampilan "kepotong" di awal landing: layer ambient dipindah dari section hero (terkunci `max-w-7xl`, tepi keras di layar lebar) ke page-level full-bleed di belakang nav + hero (`page.tsx`, `-z-10` + `mask-image` fade, `h-[100dvh]`); Hero jadi konten murni tanpa `overflow-hidden` — `npm test` 64 passed + `tsc` + `lint` hijau.
- [x] Looping animations tambahan (diminta user): keyframe `bob`/`sweep`/`blip` di `globals.css`; traffic-light terminal + dot eyebrow berkedip stagger, logo strip & ikon security melayang, scanline sweep di grid bento, shimmer `RiskMeter`, dot `live` + skeleton bar bernapas (HowItWorks), wash parallax bernapas saat diam — semuanya `motion-safe:` (test kontrak: 0 loop tanpa gate) — `npm test` 65 passed + `tsc` + `lint` hijau.
- [x] Full-visibility looping pass (diminta user lagi): wash hero naik ke 0.11/0.14 + grid alpha naik; loop dipercepat (drift 14s −30px, pulse 5s, bob 4.5s −10px, sweep 2.4s, blip 1.3s); loop BARU — radar ping (dot eyebrow, dot `live`, halo CTA hero, monogram nav), rotating dashed dial + ping di sudut terminal, equalizer bar bento (`eq` keyframe), cursor terminal di-gate `motion-safe:`; gate regex test diperluas (`ping|eq|pulse|[spin|[ping`) — `npm test` 65 passed + `tsc` + `lint` hijau.
- [x] Haluskan animasi CTA "Open dashboard" + monogram N (user: janggal): ganti ring `ping` (attack cepat, scale 2×, border ikut membesar, menabrak elemen sebelah) dengan keyframe baru `breathe` — ring materialize di tepi (opacity 0→0.7→0), scale maks 1.12× (dijamin di dalam gap 12px), ease-in-out 2.6s; hover CTA ke `duration-300 ease-out` — kontrak test (`breathe` keyframe + cap scale + dilarang `ping` di nav) — `npm test` 65 passed + `tsc` + `lint` hijau.
- [x] Fix runtime 500 di dev: komentar `//` (gaya JS) di dalam blok `@theme` `globals.css` memecah kompilasi Tailwind v4 (error `@theme blocks must only contain custom properties or @keyframes`) — komentar dihapus; guard test baru di `palette.test.ts` meng-compile `globals.css` sungguhan via PostCSS+Tailwind (string test tidak menangkap error sintaks CSS) — `npm test` 66 passed + `tsc` + `lint` hijau.

## Phase 7 — Login + Dashboard Restyle [DONE 2026-09-30: tsc OK, 34 tests pass (10 baru login+dashboard), `next build` OK]

> Keputusan terkunci: chart tetap Chart.js (tanpa recharts), dashboard = shell App1 + data OSINT penuh, semua ikon lucide (tanpa CDN 21st.dev). Hanya aditif: tambah primitif UI baru, extend card/button/badge tanpa mengubah API lama; token DESIGN.md utuh.

- [x] A — Fondasi: install `lucide-react` + Radix (`avatar, slot, progress, separator, tooltip, dialog, label`); upgrade `cn()` dukung objek/conditional; extend `tailwind.config.ts` (colors dari token lama via `hsl(var(...))`, `boxShadow.input`, animasi+keyframes `ripple`/`orbit`); `globals.css` tambah `--skeleton/--btn-border/--input/--radius` + `.g-button`
- [x] B — Primitif UI: tambah `components/ui/{avatar,label,progress,separator,tooltip,sheet}.tsx`; extend `card` (+Header/Content/Description/Footer), `button` (+size icon, varian ghost/secondary/destructive/link), `badge` (+secondary)
- [x] C — Login (`app/(auth)/sign-in/`): initial branded sign-in; auth wiring replaced 2026-10-03 by Better Auth `signIn.email`/`signIn.social`, with account creation at `/sign-up`.
- [x] D — Dashboard (`app/(dashboard)/dashboard/`): tulis `app-1-utils/` dari nol (sidebar nav Dashboard/History/target + monogram `N`, data OSINT); `App1` teradaptasi (header sticky + trigger + avatar; 4 stat cards → Open ports/Services/Vulns/Subdomains data nyata `font-mono`; area chart → Chart.js tren risk `ssr:false`; kartu bawah → Recent scans + Latest findings); komponen OSINT existing pindah ke grid App1; test + `tsc` + `build`
- [x] E — Docs: DESIGN.md (Components/Layout login/dashboard) + screenshot `public/evidence/`; risiko: token `bg-background` dkk. yang tadinya mati kini aktif (visual shift kecil, verifikasi via build + screenshot) — DONE 2026-09-30 (kontrak login + dashboard lolos; deviasi dicatat: ikon Google `Globe` ganti `Chrome`, `OverviewCards` tidak dirender di page, nav tanpa link History mati). Manual leftover: screenshot dark login/dashboard (tanpa desktop browser di sesi ini) — DONE 2026-09-30 (`login-dark.png`, `login-desktop-dark.png`, `dashboard-dark.png` di `frontend/public/evidence/`; viewport 912px, panel orbit desktop dipaksa via CSS override)

## Phase 6 — Docs & Landing Polish [DONE 2026-09-29; auth guidance superseded 2026-10-03]
- [x] README: status implementasi per fase, arsitektur singkat + link, cara jalanin (FE/BE/DB), environment dan known limits — DONE 2026-09-29 (historical state included auth stub; current auth setup documented below)
- [x] DESIGN.md: selaraskan dengan landing yang jadi — token final (`#0a0f14`, emerald `#00E59B`), font final (Space Grotesk + JetBrains Mono via next/font), struktur section final, keputusan deviasi (Shodan jadi monogram karena CDN 404, H1 `max-w-[22ch]`, 0 marquee) — DONE 2026-09-29.
- [x] Terminal hero: animasi mengetik + eksekusi layaknya terminal (ketik per karakter → cetak baris berurutan → kursor berkedip; `prefers-reduced-motion` = statis; teks tetap ada di SSR) — DONE 2026-09-29 (Hero renders `TerminalTyper`, hooks-order fix, `role="log"` + `aria-live`, kontrak di `landing.test.ts`, SSR verified via prerender `index.html`)

## Phase 5 — Landing Page [Next] — DONE 2026-09-28 (build OK, tsc OK, 5 landing tests pass; 6 sejak kontrak terminal-FX 2026-09-29)
- [x] `app/page.tsx` public + `app/_components/landing/*` (Nav 64px, Hero split + real terminal, logo strip, bento 5, How-it-works, Security, CTA + footer)
- [x] Visual: Space Grotesk + JetBrains Mono (next/font), emerald `#00E59B` single accent + black text (AA), dark-lock `#0a0f14`; landing panels use product-style static visuals without placeholder photo slots
- [x] Motion: `motion/react` Reveal (whileInView, spring 100/20) + `useReducedMotion` fallback, 0 marquee, transform/opacity only
- [x] Pre-flight: 1 CTA label (`Open dashboard`), copy audit (no fake stats), SSR content verified via curl (all sections), `/dashboard`→307 live; desktop screenshots verified in-browser + saved to `frontend/public/evidence/` (hero, bento) — DONE 2026-09-28.
- [x] Remaining visual release checks: current production build has no horizontal overflow at 390px or 1440px. Lighthouse: mobile performance 0.96, LCP 2,589ms, CLS 0.0515; desktop performance 1.00, LCP 560ms, CLS 0.0055 (2026-10-04).

## Phase 4 — Hardening, Tests, Deploy [M4]
- [x] Tests: pytest 19 passed (orchestrator partial/completed/failed, shodan/crtsh/whois mocked, auth 401, rate 429) + `npm test` 15 passed (validators, component contracts) — DONE 2026-09-28
- [x] Security sweep: bundle clean (no SHODAN/secret/db-pw in `.next/static`), `require_user` fail-closed fix + 4 tests, CORS narrowed, security headers verified live (200 + nosniff/DENY), banners escaped (0 `dangerouslySetInnerHTML` in app source), `next build` OK — DONE 2026-09-28
- [x] Empty/partial/timeout UX verified — DONE 2026-09-28 (`test_failure_modes.py`: crt.sh timeout→partial, Shodan 401→partial, WHOIS redacted→completed, full-outage→failed; FE renders `errors[]` badge + empty states, covered by component tests)
- [x] Perf: mocked cache-hit gather 0.44s, mocked miss 0.69s; LIVE `example.com` miss 5.2s server-side (<12s ✓), cache-hit POST 534–665ms server-side (<1.5s ✓, structlog `latency_ms` evidence) — DONE 2026-09-28
- [x] Prod config: `backend/Dockerfile` + `.dockerignore`, `CACHE_BACKEND=sqlite|postgres` (asyncpg `osint_cache`, fail-open), Vercel/Docker/Neon steps in WORKFLOW.md §8 — Docker image built and bundled Subfinder v2.16.0 verified 2026-10-04
- [x] Acceptance run per PRD §8 — DONE 2026-09-28: login→307 redirect ✓, live `example.com` completed (12 ports, 10 subs, WHOIS, risk 20) ✓, history 3 + trend 3 ✓, bundle clean ✓. Follow-up 2026-10-04: Docker backend startup/migrations and Subfinder verified; isolated PostgreSQL volume survived restart; current landing checked at 390px and 1440px; mobile/desktop Lighthouse run completed.

## Phase 3 — Dashboard UI [M3] — SCAFFOLD DONE (tsc OK, no SHODAN in frontend grep; needs live-key check)
- [x] `TargetSearch.tsx` (zod validation) + `ScanStatus.tsx` polling (2s until done/partial/failed)
- [x] `OverviewCards.tsx` (ports, services, vulns, subs, age) with Skeleton/error/empty states
- [x] `PortsTable.tsx`, `SubdomainsTable.tsx`, `WhoisCard.tsx` (plain-text banners) + `lib/scan-shape.ts` contract guard (crtsh dict-shape crash + `expiration_date` fix, verified live 2026-09-28: 12 ports/10 subs/Expires 2027-08-13)
- [x] `PortsChart.tsx` (doughnut + bar), `RiskTrendChart.tsx` (line) via react-chartjs-2, `ssr:false`
- [x] Dark default + light toggle, AA contrast, keyboard nav
- [x] History page (`GET /history` paginated) + trend (`GET /target/{t}/trend` last 10)
- [x] Re-scan button (`force=true`), immutable snapshot re-open

## Phase 2 — OSINT Microservices [M2] — DONE (6 pytest passed, orchestrator partial-fail covered)
- [x] `services/shodan_service.py`: domain→IP resolve, host lookup, map ports/services/vulns, timeout 12s, 2 retries
- [x] `services/crtsh_service.py`: `%25.domain` query, dedup subdomains, cap 500, timeout 15s
- [x] `services/whois_service.py`: `to_thread` wrapper, map registrar/expiry/NS/emails, handle GDPR redacted
- [x] `core/cache.py`: SQLite `cache(key, payload, expires_at)` TTL 24h, `force` bypass
- [x] `services/orchestrator.py`: `asyncio.gather(return_exceptions=True)` → aggregated + `errors[]`
- [x] `services/risk.py`: heuristic v1 + breakdown (PRD §6)
- [x] Routers `POST /api/v1/scan`, `GET /api/v1/scan/{id}` with Pydantic validation + private-IP block; FE proxy `[...path]`→`[[...path]]` fix (bare `/api/scan` 404) verified live 2026-09-28
- [x] Rate limit 10/hour/user + structured logs + X-Request-ID

## Phase 1 — Auth + DB Foundation [M1] — DONE (auth APIs, DB sessions and owner isolation verified in focused tests; live DB/provider setup remains deployment-dependent)
- [x] Better Auth server/client wiring for email/password; optional Google/GitHub providers require real credentials
- [x] Next `middleware.ts` guards `(dashboard)/*`, proxy `app/api/scan/[...path]/route.ts` forwards session
- [x] SQLAlchemy models `targets, scans, findings` + initial Alembic revision; fresh PostgreSQL upgrade and drift check verified 2026-10-04
- [x] `GET /health`, `GET /ready` return 200; CORS allowlist only APP_URL
- [x] `require_user()` rejects unauthed with 401 (test)

## Phase 0 — Docs & Scaffold [M1] — DONE 2026-09-27 (verified: py_compile OK, tsc OK)
- [x] Monorepo layout (`frontend/`, `backend/`, `docker-compose.yml`) per ARCHITECTURE.md §2
- [x] `frontend/.env.local.example` + `backend/.env.example` + `.gitignore` (.env, data/*.db)
- [x] `docker-compose.yml` with `postgres:16` (db `osint`, user `osint`)
- [x] README quickstart links to WORKFLOW.md

Open items live in [TODO.md](./TODO.md); setup steps in [WORKFLOW.md](./WORKFLOW.md).

### Scope note
The PostgreSQL-backed signup/session/protected-scan/sign-out flow was verified live and its synthetic test data was removed. Google/GitHub login was confirmed working by the user on 2026-10-04. The Alembic baseline preserves the existing schema and is verified on fresh and existing databases. Clean-room tests, Docker startup, database volume persistence, source/history secret scans, and current-build responsive/performance checks passed. Maintainer approval for the CC-BY-4.0 dependency remains an external action. The UI animation request was approved and shipped on 2026-10-06 (see Phase 8 and the looping entries below), so it is no longer pending; the DB password change is an external secret/config action rather than a repository edit.

## Backlog (v2, do NOT start) — moved to TODO.md
