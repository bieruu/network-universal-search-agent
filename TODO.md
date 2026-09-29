# TODO — Network Universal Search Agent

> Order of execution. Check off as you go. References: PRD.md, ARCHITECTURE.md, WORKFLOW.md.

## Phase 0 — Docs & Scaffold [M1] — DONE 2026-09-27 (verified: py_compile OK, tsc OK)
- [x] Monorepo layout (`frontend/`, `backend/`, `docker-compose.yml`) per ARCHITECTURE.md §2
- [x] `frontend/.env.local.example` + `backend/.env.example` + `.gitignore` (.env, data/*.db)
- [x] `docker-compose.yml` with `postgres:16` (db `osint`, user `osint`)
- [x] README quickstart links to WORKFLOW.md

## Phase 1 — Auth + DB Foundation [M1] — DONE (stub Better Auth, middleware + proxy, models, /health verified `{"status":"ok"}`, 401 test passes)
- [x] Better Auth setup (email + OAuth provider), session cookie httpOnly/Secure
- [x] Next `middleware.ts` guards `(dashboard)/*`, proxy `app/api/scan/[...path]/route.ts` forwards session
- [x] SQLAlchemy models `targets, scans, findings` + Alembic `upgrade head` works
- [x] `GET /health`, `GET /ready` return 200; CORS allowlist only APP_URL
- [x] `require_user()` rejects unauthed with 401 (test)

## Phase 2 — OSINT Microservices [M2] — DONE (6 pytest passed, orchestrator partial-fail covered)
- [x] `services/shodan_service.py`: domain→IP resolve, host lookup, map ports/services/vulns, timeout 12s, 2 retries
- [x] `services/crtsh_service.py`: `%25.domain` query, dedup subdomains, cap 500, timeout 15s
- [x] `services/whois_service.py`: `to_thread` wrapper, map registrar/expiry/NS/emails, handle GDPR redacted
- [x] `core/cache.py`: SQLite `cache(key, payload, expires_at)` TTL 24h, `force` bypass
- [x] `services/orchestrator.py`: `asyncio.gather(return_exceptions=True)` → aggregated + `errors[]`
- [x] `services/risk.py`: heuristic v1 + breakdown (PRD §6)
- [x] Routers `POST /api/v1/scan`, `GET /api/v1/scan/{id}` with Pydantic validation + private-IP block; FE proxy `[...path]`→`[[...path]]` fix (bare `/api/scan` 404) verified live 2026-09-28
- [x] Rate limit 10/hour/user + structured logs + X-Request-ID

## Phase 3 — Dashboard UI [M3] — SCAFFOLD DONE (tsc OK, no SHODAN in frontend grep; needs live-key check)
- [x] `TargetSearch.tsx` (zod validation) + `ScanStatus.tsx` polling (2s until done/partial/failed)
- [x] `OverviewCards.tsx` (ports, services, vulns, subs, age) with Skeleton/error/empty states
- [x] `PortsTable.tsx`, `SubdomainsTable.tsx`, `WhoisCard.tsx` (plain-text banners) + `lib/scan-shape.ts` contract guard (crtsh dict-shape crash + `expiration_date` fix, verified live 2026-09-28: 12 ports/10 subs/Expires 2027-08-13)
- [x] `PortsChart.tsx` (doughnut + bar), `RiskTrendChart.tsx` (line) via react-chartjs-2, `ssr:false`
- [x] Dark default + light toggle, AA contrast, keyboard nav
- [x] History page (`GET /history` paginated) + trend (`GET /target/{t}/trend` last 10)
- [x] Re-scan button (`force=true`), immutable snapshot re-open

## Phase 4 — Hardening, Tests, Deploy [M4]
- [x] Tests: pytest 19 passed (orchestrator partial/completed/failed, shodan/crtsh/whois mocked, auth 401, rate 429) + `npm test` 15 passed (validators, component contracts) — DONE 2026-09-28
- [x] Security sweep: bundle clean (no SHODAN/secret/db-pw in `.next/static`), `require_user` fail-closed fix + 4 tests, CORS narrowed, security headers verified live (200 + nosniff/DENY), banners escaped (0 `dangerouslySetInnerHTML` in app source), `next build` OK — DONE 2026-09-28
- [x] Empty/partial/timeout UX verified — DONE 2026-09-28 (`test_failure_modes.py`: crt.sh timeout→partial, Shodan 401→partial, WHOIS redacted→completed, full-outage→failed; FE renders `errors[]` badge + empty states, covered by component tests)
- [x] Perf: mocked cache-hit gather 0.44s, mocked miss 0.69s; LIVE `example.com` miss 5.2s server-side (<12s ✓), cache-hit POST 534–665ms server-side (<1.5s ✓, structlog `latency_ms` evidence) — DONE 2026-09-28
- [x] Prod config: `backend/Dockerfile` + `.dockerignore`, `CACHE_BACKEND=sqlite|postgres` (asyncpg `osint_cache`, fail-open), Vercel/Docker/Neon steps in WORKFLOW.md §8 — DONE 2026-09-28 (`docker build` not verified: docker missing)
- [x] Acceptance run per PRD §8 — DONE 2026-09-28: login→307 redirect ✓, live `example.com` completed (12 ports, 10 subs, WHOIS, risk 20) ✓, history 3 + trend 3 ✓, bundle clean ✓. Manual leftovers: Postgres persist-across-restart, 390/1440px screenshots (no desktop browser in session), `docker compose up` (no docker)

## Phase 5 — Landing Page [Next] — DONE 2026-09-28 (build OK, tsc OK, 5 landing tests pass; 6 sejak kontrak terminal-FX 2026-09-29)
- [x] `app/page.tsx` public + `app/_components/landing/*` (Nav 64px, Hero split + real terminal, logo strip, bento 5, How-it-works, Security, CTA + footer)
- [x] Visual: Space Grotesk + JetBrains Mono (next/font), emerald `#00E59B` single accent + black text (AA), dark-lock `#0a0f14`; 3 picsum seeds + TODO slots
- [x] Motion: `motion/react` Reveal (whileInView, spring 100/20) + `useReducedMotion` fallback, 0 marquee, transform/opacity only
- [x] Pre-flight: 1 CTA label (`Open dashboard`), copy audit (no fake stats), SSR content verified via curl (all sections), `/dashboard`→307 live; desktop screenshots verified in-browser + saved to `frontend/public/evidence/` (hero, bento) — DONE 2026-09-28. Leftover manual: 390px check, Lighthouse LCP/CLS.

## Phase 6 — Docs & Landing Polish [PROPOSED 2026-09-28, belum dikerjakan]
- [x] README: status implementasi per fase, arsitektur singkat + link, cara jalanin (FE/BE/DB), cara login dev (cookie), env yang wajib dirotasi, batasan known (auth stub, docker belum diverifikasi) — DONE 2026-09-29 (skor: FE 24 passed + tsc clean + build OK; BE 30 passed, 2 env-only PermissionError Windows temp-dir)
- [x] DESIGN.md: selaraskan dengan landing yang jadi — token final (`#0a0f14`, emerald `#00E59B`), font final (Space Grotesk + JetBrains Mono via next/font), struktur section final, keputusan deviasi (Shodan jadi monogram karena CDN 404, H1 `max-w-[22ch]`, 0 marquee) — DONE 2026-09-29 (§1/§2/§6/§8/§10 as-built + pre-flight checked kecuali 390px + Lighthouse)
- [x] Terminal hero: animasi mengetik + eksekusi layaknya terminal (ketik per karakter → cetak baris berurutan → kursor berkedip; `prefers-reduced-motion` = statis; teks tetap ada di SSR) — DONE 2026-09-29 (Hero renders `TerminalTyper`, hooks-order fix, `role="log"` + `aria-live`, kontrak di `landing.test.ts`, SSR verified via prerender `index.html`)

## Phase 7 — Login + Dashboard Restyle [PLANNED 2026-09-29, belum dikerjakan]

> Keputusan terkunci: chart tetap Chart.js (tanpa recharts), dashboard = shell App1 + data OSINT penuh, semua ikon lucide (tanpa CDN 21st.dev). Hanya aditif: tambah primitif UI baru, extend card/button/badge tanpa mengubah API lama; token DESIGN.md utuh.

- [ ] A — Fondasi: install `lucide-react` + Radix (`avatar, slot, progress, separator, tooltip, dialog, label`); upgrade `cn()` dukung objek/conditional; extend `tailwind.config.ts` (colors dari token lama via `hsl(var(...))`, `boxShadow.input`, animasi+keyframes `ripple`/`orbit`); `globals.css` tambah `--skeleton/--btn-border/--input/--radius` + `.g-button`
- [ ] B — Primitif UI: tambah `components/ui/{avatar,label,progress,separator,tooltip,sheet}.tsx`; extend `card` (+Header/Content/Description/Footer), `button` (+size icon, varian ghost/secondary/destructive/link), `badge` (+secondary)
- [ ] C — Login (`app/(auth)/sign-in/`): `modern-animated-sign-in.tsx` teradaptasi (accent emerald `#00E59B`, ikon lucide semua, `BoxReveal` + `useReducedMotion`, `grid-cols` hardcode, tanpa `console.log`/CDN, path import diluruskan); wire submit → `authClient.signInEmail` → `router.push('/dashboard')`, gagal → `errorField`, Google → `signInOAuth`, "Forgot password?" dibuang; panel kiri orbit + teks produk; test kontrak baru + `tsc` + `build`
- [ ] D — Dashboard (`app/(dashboard)/dashboard/`): tulis `app-1-utils/` dari nol (sidebar nav Dashboard/History/target + monogram `N`, data OSINT); `App1` teradaptasi (header sticky + trigger + avatar; 4 stat cards → Open ports/Services/Vulns/Subdomains data nyata `font-mono`; area chart → Chart.js tren risk `ssr:false`; kartu bawah → Recent scans + Latest findings); komponen OSINT existing pindah ke grid App1; test + `tsc` + `build`
- [ ] E — Docs: DESIGN.md §10–§11 (file map + pre-flight login/dashboard) + screenshot `public/evidence/`; risiko: token `bg-background` dkk. yang tadinya mati kini aktif (visual shift kecil, verifikasi via build + screenshot)

## Backlog (v2, do NOT start)
- [ ] Scheduled monitoring + diff alerts
- [ ] PDF/CSV export, webhooks
- [ ] Org RBAC, Redis cache, SSE instead of polling
