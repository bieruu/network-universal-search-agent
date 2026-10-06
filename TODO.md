# TODO — Network Universal Search Agent

> Only actionable work lives here. Completed work → [CHANGELOG.md](./CHANGELOG.md).
> Refs: [PRD.md](./PRD.md) (what) · [ARCHITECTURE.md](./ARCHITECTURE.md) (how) · [WORKFLOW.md](./WORKFLOW.md) (commands).

## Security hardening — pre-deployment audit (2026-10-06)

> Full audit result: 🟡 Perlu Perbaikan Kritis. Items 1–6 block production deploy; 7–12 are strongly advised. Re-run the gates after each fix: `pytest && ruff && black` + `lint && tsc && npm test && build`.

### P1 — must fix before deploy

- [x] Pin backend dependencies: split `requirements.in` / `requirements-dev.in`, compiled to pinned + hashed `requirements.txt` (runtime, 35 pkgs) / `requirements-dev.txt` (runtime + pytest/respx/ruff/black) via `uv pip compile --generate-hashes`; `backend/Dockerfile` installs runtime only with `--require-hashes`. Dev flows (README/AGENTS/WORKFLOW/dev.ps1) now use `requirements-dev.txt`.
- [x] Run the backend container as non-root: `backend/Dockerfile` adds `groupadd`/`useradd app`, chowns `/srv/app` (incl. `data/`), and sets `USER app`.
- [x] Fix npm high vulnerability: `npm audit fix` run from `frontend/` → `source-map-js` bumped, **0 vulnerabilities** remain.
- [x] Disable FastAPI schema/docs in production: `docs_url`/`redoc_url`/`openapi_url` set to `None` when `settings.is_production` (`backend/app/main.py`), covered by `test_docs_disabled_in_production`.
- [x] Add a production CORS guard: `model_post_init` raises if `is_production` and `"*"` in `cors_list` (`backend/app/core/config.py`), covered by `test_production_rejects_wildcard_cors`.
- [x] Add `Content-Security-Policy` and `Strict-Transport-Security` headers: `Content-Security-Policy-Report-Only` (with `sha256-` hash of the inline theme script) + `Strict-Transport-Security` added in `frontend/next.config.mjs`. Enforcement still needs a nonce for Next.js hydration scripts (documented in the file). The script hash is now recomputed and locked by `frontend/lib/security-headers.test.ts`, so it cannot silently drift when `app/layout.tsx` is edited.

### P2 — strongly advised

- [x] Split the Bearer fallback: new `SERVICE_TOKEN` env (`settings.service_token`); `require_user()` accepts `Bearer` only against it — `BETTER_AUTH_SECRET` is now rejected as an API key, and unset token fails closed (tests updated/added).
- [x] Do not publish Postgres in production: `docker-compose.yml` binds `127.0.0.1:5432:5432` and the obsolete `version:` key is dropped; comment notes prod must use internal-only networking.
- [x] Move rate limiting out of process memory: documented as a known limitation in ARCHITECTURE.md §6 (in-memory fixed window resets on restart × worker count; single worker in prod or Redis/Postgres in v2).
- [x] Stop leaking exception class names from `/ready`: returns plain `degraded` when `settings.is_production` (class name kept in dev for debugging).
- [x] CI security gates: required-check list documented in WORKFLOW.md §6 (npm audit, pip-audit/`uv pip compile --check`, lint/tsc/test/build, secret scan) for whenever `.github/` is un-ignored.
- [x] Enforce TLS on data/auth paths: production `Settings` rejects non-localhost Postgres URLs without `sslmode=require` (`test_production_requires_tls_database_url`); Next `middleware.ts` fails closed (503) when `BETTER_AUTH_URL` is plain http on a non-localhost host in production.

## Backlog (v2 — do NOT start)

- [ ] Scheduled monitoring + diff alerts
- [ ] PDF/CSV export, webhooks
- [ ] Org RBAC, Redis cache, SSE instead of polling
