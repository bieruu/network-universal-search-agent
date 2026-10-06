# AGENTS.md — Rules for AI / Human Contributors

> Read this before writing code. This repo is a secure OSINT dashboard. Correctness + security > speed.

## 1. Project Snapshot

- `frontend/` — Next.js App Router + TypeScript + Tailwind + shadcn/ui + react-chartjs-2.
- `backend/` — FastAPI async + SQLAlchemy + Pydantic v2. Services: shodan, crtsh, whois, orchestrator, risk.
- DB: PostgreSQL (truth) + SQLite (TTL cache). Auth: Better Auth (session-gated).
- Docs: README.md (start here), PRD.md (what), ARCHITECTURE.md (how), DESIGN.md (UI), WORKFLOW.md (commands), TODO.md (open items), CHANGELOG.md (history).

## 2. Commands (Use These, Don't Invent)

```bash
# Frontend (frontend/)
npm install && npm run dev        # http://localhost:3000 (lockfile: package-lock.json)
npm run lint && npm run tsc --noEmit && npm test

# Backend (backend/)
python -m venv .venv && pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
pytest -q && ruff check . && black --check .

# DB
docker compose up -d postgres    # DATABASE_URL=postgresql://osint:osint@localhost:5432/osint
alembic upgrade head
```

Node ≥20, Python ≥3.11. Never add a new package manager or Chart lib without approval.

## 3. Structure Rules

- Frontend: App Router only (`app/`). Shared UI only from `components/ui/` (shadcn). Charts in `app/(dashboard)/dashboard/_components/*Chart.tsx`, dynamic import `ssr:false`.
- Backend: routers thin (validate + call service), logic in `services/`, schemas in `schemas/`, models in `models/`. No `requests` (use `httpx.AsyncClient`), no sync I/O in async path (use `asyncio.to_thread` for whois).
- No new top-level folders. Raw OSINT JSON → SQLite cache; normalized snapshot → Postgres `scans.result_snapshot` (immutable).

## 4. Code Style

- TS: strict, `zod` for forms, `async/await` with try/catch → user-friendly error badge. No `any` without comment.
- Python: `ruff + black`, type hints, Pydantic v2, `httpx` timeouts always set, truncate external strings (banner ≤2KB, lists ≤500).
- Naming: `*_service.py`, `*_router.py`, components PascalCase. Commits: `feat:`, `fix:`, `chore:`, `docs:`.

## 5. Security — MUST Follow

1. **Secrets:** only via env (`SHODAN_API_KEY`, `BETTER_AUTH_SECRET`, `DATABASE_URL`). Never log, never return to client, never commit `.env`. Grep before PR: `SHODAN|SECRET|DATABASE_URL`.
2. **Auth:** every scan/history endpoint calls `require_user()`. Frontend proxy forwards session; direct FastAPI call without session → 401.
3. **Validation:** Zod (FE) + Pydantic regex (BE) for domain/IP; block `localhost` + RFC1918 + `169.254/16`. Render banners/WHOIS as plain text.
4. **External data:** treat Shodan/crt.sh/WHOIS as untrusted — Pydantic parse, `.get()` defaults, catch `Timeout/HTTPError` → `errors[]`, never 500 on source failure.
5. **Limits:** respect `RATE_LIMIT_PER_HOUR`, per-source timeouts (12/15/10s), shared httpx client, no parallel fan-out beyond orchestrator.

## 6. UI/UX Rules

- Dark default (`class="dark"`), shadcn `Card/Table/Badge/Skeleton/Tabs` only. No inline `style` for theme.
- Per-card loading (`Skeleton`) + error (`Badge variant=destructive`) + empty state ("No subdomains found"). Partial results must still render.
- Charts: Chart.js only, accessible labels, `aria-label`, responsive, no 3D/pie-spam.

## 7. DO / DON'T

DO:
- Add tests for new service + orchestrator partial-failure path.
- Update TODO.md checkbox + ARCHITECTURE.md if contract changes.
- Use `X-Request-ID` in logs, return `errors: [{source, message}]`.
- Parallelize independent subtasks (multiple agents / tool calls) when they do not share state.

DON'T:
- Don't call Shodan/crt.sh from browser. Don't add active scanning (nmap) in v1.
- Don't store raw secrets/PII beyond audit minimum. Don't bypass cache without `force=true`.
- Don't create migrations by hand-editing DB; use Alembic.

## 8. PR Checklist

- [ ] `npm run lint && npm run tsc` + `pytest && ruff` pass
- [ ] No secrets in diff, inputs validated FE+BE, partial-failure tested (kill one source)
- [ ] Screenshots for UI change (dark + light), charts with real + empty data
- [ ] Docs updated if API/env/schema changed

When in doubt: fail closed (401/429/partial), log structured, keep UI usable.
