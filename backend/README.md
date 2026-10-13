---
title: OSINT Dashboard API
emoji: 🔍
colorFrom: slate
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
---

Backend API (FastAPI) for the OSINT dashboard. This repository is the
`backend/` subtree of
[network-universal-search-agent](https://github.com/bieruu/network-universal-search-agent)
and is pushed here with `git subtree push --prefix=backend` — the deploy
runbook (environment variables, secrets, and the verification steps) lives in
`WORKFLOW.md` §8.6 of that repository.

### Runtime contract

| Item | Value |
|---|---|
| Port | `7860` (HF Docker Spaces routes HTTP here; `$PORT` overrides locally) |
| Entrypoint | `alembic upgrade head` then uvicorn (see `Dockerfile`) |
| Liveness | `GET /health` (no dependencies) |
| Readiness | `GET /ready` (opens one database connection) |

### Configuration

All configuration is injected by the platform as real environment variables
from **Settings → Variables and secrets** (secrets stay encrypted; plain
variables are only for non-sensitive settings). Nothing is read from a
committed `.env` — the app fails closed on missing production settings rather
than booting with defaults. See `backend/.env.example` in the source repo for
the full annotated list.
