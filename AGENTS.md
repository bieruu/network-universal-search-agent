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
python -m venv .venv && pip install -r requirements-dev.txt
uvicorn app.main:app --reload --port 8000
pytest -q && ruff check . && black --check .

# DB
docker compose up -d postgres    # DATABASE_URL=postgresql+asyncpg://owner:<password>@localhost:5432/osint
alembic upgrade head
```

Node ≥22.18 (the test suite runs `.ts` files directly, which needs Node's unflagged type stripping), Python ≥3.11. Never add a new package manager or Chart lib without approval.

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
- **At push time (not before), move what you finished from TODO.md into CHANGELOG.md**, newest section first, and fix older entries this push made wrong (§9).

DON'T:
- Don't call Shodan/crt.sh from browser. Don't add active scanning (nmap) in v1.
- Don't store raw secrets/PII beyond audit minimum. Don't bypass cache without `force=true`.
- Don't create migrations by hand-editing DB; use Alembic.

## 8. PR Checklist

- [ ] `npm run lint && npm run tsc` + `pytest && ruff` pass
- [ ] No secrets in diff, inputs validated FE+BE, partial-failure tested (kill one source)
- [ ] Screenshots for UI change (dark + light), charts with real + empty data
- [ ] Docs updated if API/env/schema changed
- [ ] Finished TODO items ticked `[x]` as they completed (§9)
- [ ] TODO.md → CHANGELOG.md swept at push time: ticked items moved out and deleted from TODO, new section on top, superseded entries annotated (§9)

## 9. TODO.md → CHANGELOG.md

`TODO.md` tracks work; `CHANGELOG.md` records what shipped. The two are linked but move on different triggers:

- **Tick `[x]` as soon as an item is genuinely done.** It stays in TODO.md, ticked, until a push sweeps it.
- **Moving to CHANGELOG.md happens at push time, in the same commit as the code** — never as a separate docs commit afterwards.

So a finished item sitting in TODO.md with a `[x]` is the *expected* resting state, not a failure. A ticked item only goes wrong when it is left behind forever: if a sweep passes and a `[x]` is still in TODO.md, that item was never moved, and it is a missed item.

While working:

1. Tick `[x]` each item as it is actually completed — same commit as the code that completes it, or any later one in the same push.
2. Leave the item in TODO.md, ticked. Do not pre-write CHANGELOG prose for work that is not pushed; it would claim a ship that has not happened.
3. Keep everything genuinely open unticked.

At push time:

1. Collect every `[x]` item in TODO.md that belongs to this push.
2. Move those items **out of** TODO.md into one new dated `## YYYY-MM-DD — <title>` section in CHANGELOG.md, and delete them from TODO.md.
3. Newest section goes **first**, directly under the header block. Existing entries are never reordered or renumbered; one push = one new top section.
4. State what changed and the gate numbers in the entry — the CHANGELOG is the record of what actually shipped.
5. Anything still open stays in TODO.md, unticked. A `[x]` that survives a push is the failure mode: the sweep missed it.

Before you push, also correct CHANGELOG entries that this push made wrong: an entry that is now inaccurate or superseded gets a dated inline note (`superseded YYYY-MM-DD` / `reversed YYYY-MM-DD`) pointing at the newer entry. Leave the original claim visible — the history is the point; silently rewriting it destroys the audit trail.

Honesty rules for both files:

- Only tick an item that is genuinely done. A plan or a review finding is still open work.
- Never claim a gate passed without running it in this session; write the numbers you observed.
- If a gate did not run, say so in the entry instead of implying it passed.
- Mark anything unverified as unverified. Do not present an assumption about a dependency's defaults as a finding.
- A tick asserts the work exists and its gates ran — not that it was deployed. Deployment stays in its own section until it happens.

When in doubt: fail closed (401/429/partial), log structured, keep UI usable.
