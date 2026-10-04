# TODO — Network Universal Search Agent

> Order of execution. Check off as you go. References: PRD.md, ARCHITECTURE.md, WORKFLOW.md.

## Phase 0 — Docs & Scaffold [M1] — DONE 2026-09-27 (verified: py_compile OK, tsc OK)
- [x] Monorepo layout (`frontend/`, `backend/`, `docker-compose.yml`) per ARCHITECTURE.md §2
- [x] `frontend/.env.local.example` + `backend/.env.example` + `.gitignore` (.env, data/*.db)
- [x] `docker-compose.yml` with `postgres:16` (db `osint`, user `osint`)
- [x] README quickstart links to WORKFLOW.md

## Phase 1 — Auth + DB Foundation [M1] — DONE (auth APIs, DB sessions and owner isolation verified in focused tests; live DB/provider setup remains deployment-dependent)
- [x] Better Auth server/client wiring for email/password; optional Google/GitHub providers require real credentials
- [x] Next `middleware.ts` guards `(dashboard)/*`, proxy `app/api/scan/[...path]/route.ts` forwards session
- [x] SQLAlchemy models `targets, scans, findings` + initial Alembic revision; fresh PostgreSQL upgrade and drift check verified 2026-10-04
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
- [x] Prod config: `backend/Dockerfile` + `.dockerignore`, `CACHE_BACKEND=sqlite|postgres` (asyncpg `osint_cache`, fail-open), Vercel/Docker/Neon steps in WORKFLOW.md §8 — Docker image built and bundled Subfinder v2.16.0 verified 2026-10-04
- [x] Acceptance run per PRD §8 — DONE 2026-09-28: login→307 redirect ✓, live `example.com` completed (12 ports, 10 subs, WHOIS, risk 20) ✓, history 3 + trend 3 ✓, bundle clean ✓. Follow-up 2026-10-04: Docker backend startup/migrations and Subfinder verified; isolated PostgreSQL volume survived restart; current landing checked at 390px and 1440px; mobile/desktop Lighthouse run completed.

## Phase 5 — Landing Page [Next] — DONE 2026-09-28 (build OK, tsc OK, 5 landing tests pass; 6 sejak kontrak terminal-FX 2026-09-29)
- [x] `app/page.tsx` public + `app/_components/landing/*` (Nav 64px, Hero split + real terminal, logo strip, bento 5, How-it-works, Security, CTA + footer)
- [x] Visual: Space Grotesk + JetBrains Mono (next/font), emerald `#00E59B` single accent + black text (AA), dark-lock `#0a0f14`; landing panels use product-style static visuals without placeholder photo slots
- [x] Motion: `motion/react` Reveal (whileInView, spring 100/20) + `useReducedMotion` fallback, 0 marquee, transform/opacity only
- [x] Pre-flight: 1 CTA label (`Open dashboard`), copy audit (no fake stats), SSR content verified via curl (all sections), `/dashboard`→307 live; desktop screenshots verified in-browser + saved to `frontend/public/evidence/` (hero, bento) — DONE 2026-09-28.
- [x] Remaining visual release checks: current production build has no horizontal overflow at 390px or 1440px. Lighthouse: mobile performance 0.96, LCP 2,589ms, CLS 0.0515; desktop performance 1.00, LCP 560ms, CLS 0.0055 (2026-10-04).

## Phase 6 — Docs & Landing Polish [DONE 2026-09-29; auth guidance superseded 2026-10-03]
- [x] README: status implementasi per fase, arsitektur singkat + link, cara jalanin (FE/BE/DB), environment dan known limits — DONE 2026-09-29 (historical state included auth stub; current auth setup documented below)
- [x] DESIGN.md: selaraskan dengan landing yang jadi — token final (`#0a0f14`, emerald `#00E59B`), font final (Space Grotesk + JetBrains Mono via next/font), struktur section final, keputusan deviasi (Shodan jadi monogram karena CDN 404, H1 `max-w-[22ch]`, 0 marquee) — DONE 2026-09-29.
- [x] Terminal hero: animasi mengetik + eksekusi layaknya terminal (ketik per karakter → cetak baris berurutan → kursor berkedip; `prefers-reduced-motion` = statis; teks tetap ada di SSR) — DONE 2026-09-29 (Hero renders `TerminalTyper`, hooks-order fix, `role="log"` + `aria-live`, kontrak di `landing.test.ts`, SSR verified via prerender `index.html`)

## Phase 7 — Login + Dashboard Restyle [DONE 2026-09-30: tsc OK, 34 tests pass (10 baru login+dashboard), `next build` OK]

> Keputusan terkunci: chart tetap Chart.js (tanpa recharts), dashboard = shell App1 + data OSINT penuh, semua ikon lucide (tanpa CDN 21st.dev). Hanya aditif: tambah primitif UI baru, extend card/button/badge tanpa mengubah API lama; token DESIGN.md utuh.

- [x] A — Fondasi: install `lucide-react` + Radix (`avatar, slot, progress, separator, tooltip, dialog, label`); upgrade `cn()` dukung objek/conditional; extend `tailwind.config.ts` (colors dari token lama via `hsl(var(...))`, `boxShadow.input`, animasi+keyframes `ripple`/`orbit`); `globals.css` tambah `--skeleton/--btn-border/--input/--radius` + `.g-button`
- [x] B — Primitif UI: tambah `components/ui/{avatar,label,progress,separator,tooltip,sheet}.tsx`; extend `card` (+Header/Content/Description/Footer), `button` (+size icon, varian ghost/secondary/destructive/link), `badge` (+secondary)
- [x] C — Login (`app/(auth)/sign-in/`): initial branded sign-in; auth wiring replaced 2026-10-03 by Better Auth `signIn.email`/`signIn.social`, with account creation at `/sign-up`.
- [x] D — Dashboard (`app/(dashboard)/dashboard/`): tulis `app-1-utils/` dari nol (sidebar nav Dashboard/History/target + monogram `N`, data OSINT); `App1` teradaptasi (header sticky + trigger + avatar; 4 stat cards → Open ports/Services/Vulns/Subdomains data nyata `font-mono`; area chart → Chart.js tren risk `ssr:false`; kartu bawah → Recent scans + Latest findings); komponen OSINT existing pindah ke grid App1; test + `tsc` + `build`
- [x] E — Docs: DESIGN.md (Components/Layout login/dashboard) + screenshot `public/evidence/`; risiko: token `bg-background` dkk. yang tadinya mati kini aktif (visual shift kecil, verifikasi via build + screenshot) — DONE 2026-09-30 (kontrak login + dashboard lolos; deviasi dicatat: ikon Google `Globe` ganti `Chrome`, `OverviewCards` tidak dirender di page, nav tanpa link History mati). Manual leftover: screenshot dark login/dashboard (tanpa desktop browser di sesi ini) — DONE 2026-09-30 (`login-dark.png`, `login-desktop-dark.png`, `dashboard-dark.png` di `frontend/public/evidence/`; viewport 912px, panel orbit desktop dipaksa via CSS override)

## Phase 8 — Dashboard & Theme Follow-up [DONE 2026-09-30]

- [x] Selaraskan warna dan tampilan dashboard dengan landing page dan login.
- [x] Rapikan layout dashboard, termasuk container pada ukuran layar yang diuji.
- [x] Arahkan klik logo/monogram `N` di dashboard kembali ke landing page.
- [x] pisahkan perilaku scrolling aside dengan halaman utama agar aside tidak ikut bergulir.
- [x] Tambahkan toggle dark/light di landing dan login; dark tetap default dan preferensi tema tersimpan lintas kedua halaman. Perbarui aturan dark-only di DESIGN.md saat implementasi.
- [x] Selaraskan animasi logo berputar dengan outline-nya pada tampilan desktop fullscreen.
- [x] di landing page, bagian sample output scan hanya menggunakan example.com, buat sampel mengscan 3 website berbeda dan di looping agar tampilan website lebih menarik.

## Phase 9 — Shared Color Palette [DONE 2026-10-01: npm test 41 passed (6 baru palette), tsc clean, `next build` OK]

- [x] Tetapkan palet sign-in sebagai acuan bersama: background dark `#0a0f14`, surface neutral gelap, accent emerald `#00E59B`, teks kontras, serta pasangan warna light yang konsisten dan mudah dibaca.
- [x] Selaraskan warna landing dan sign-in pada mode dark/light; dark tetap default dan toggle serta preferensi tema harus berperilaku sama di kedua halaman.
- [x] Dokumentasikan token palet dan aturan penggunaannya lintas tema di DESIGN.md saat pekerjaan implementasi dilakukan.
- [x] Setelah palet landing/sign-in ditetapkan, terapkan palet yang sama pada semua page, termasuk dashboard; audit background, surface, teks, border, state, dan accent.
- [x] Verifikasi kontras dark/light dan jalankan frontend tests, TypeScript, serta build setelah implementasi.
- Browser 2026-10-01: landing/sign-in/dashboard dark+light OK, Lighthouse 1.0/1.0/1.0, bukti `frontend/public/evidence/phase9-*`. Current-build 390px/1440px viewport and LCP/CLS rechecked 2026-10-04 under Phase 5.

## Phase 10 — Palette Token Alignment + Mobile Sheet Fix [DONE 2026-10-01: npm test 43 passed (2 baru), tsc clean, `next build` OK]

- [x] Migrasi semua `#00E59B` literal → utilitas token global (`bg-accent/text-accent/border-accent/text-accent-foreground`); hex hanya di `--accent` + URL Simple Icons; kontrak di `login.test.ts` + `palette.test.ts`
- [x] Fix sheet burger kosong di mobile (`max-md:flex` override `hidden`; sebab: `cn()` plain-join, `.hidden` menang atas `.flex` di cascade) + `Button` `forwardRef` untuk `asChild`; kontrak di `dashboard.test.ts`; terverifikasi di CSS produksi

## Phase 11 — One-Script Dev + Auto-Login [SUPERSEDED 2026-10-03]

- [x] `dev.ps1` di root: 1 perintah nyalakan backend+frontend, install otomatis yang kurang (venv/deps/node_modules), reclaim port 3000/8000, tunggu sehat, buka browser; Ctrl+C matikan dua tree; murni ASCII agar lolos parser Windows PowerShell 5.1
- [x] Historical dev-cookie helper removed when the real Better Auth DB-backed flow was added; `/dev-login` no longer exists.

## Phase 12 — Dashboard Parity dengan Landing [DONE: npm test 48 passed, tsc clean, `next build` OK, verifikasi browser dark+light]

- [x] Blue cast hilang: dark `--background/skeleton/input/border/muted` dinetralkan (`--background: 210 33% 6%` = `#0a0f14` persis); diverifikasi computed `rgb(10,15,20)` di landing + dashboard
- [x] Font global: Space Grotesk + JetBrains Mono pindah ke root `layout.tsx` (dashboard/sign-in sebelumnya jatuh ke system font); duplikasi di landing `page.tsx` dibuang
- [x] Button base jadi pill (`rounded-full`) seperti CTA landing; `forwardRef` tetap
- [x] Status colors ber-token: `--warning`/`--danger` light/dark; ScanStatus + TargetSearch pakai token (amber-300/red-400 polos dibuang); border tabel dipasangkan light/dark
- [x] Chart pakai warna token (`lib/chart-theme.ts`: accent dataset, grid `btn-border`, tick `muted`) + re-render saat toggle tema via MutationObserver
- [x] Kontrak: `palette.test.ts` (token warning/danger/panel, bg netral, font di root, base pill) + `dashboard.test.ts` (status token, border tabel, chart palette)
- Catatan investigasi: kartu yang "macet gelap" saat toggle di window tersembunyi = artefak (CSS transition clock beku; body tanpa transisi flip benar, klon segar benar). Reload langsung di light: semua kartu putih, border terang, 0 animasi — kode benar.

## Phase 13 — Terminal Clear Transition [DONE 2026-10-01: npm test 48 passed, tsc clean]

- [x] Sample output loop di landing tidak lagi lompat tiba-tiba: setelah output selesai, terminal mengetik `clear` lalu mengosongkan layar sebelum scan berikutnya, sehingga 3 sampel (`example.com` → `api.acme.co` → `portal.nova.io`) terbaca sebagai satu sesi shell berkelanjutan (`TerminalTyper.tsx`: state `clearChars` + konstanta `CLEAR_CMD`/`CLEAR_PAUSE_MS`/`CLEAR_BLANK_MS`; reduced-motion tetap statis). DESIGN.md Physics + Terminal diperbarui.
- [x] Animasi clear (bukan hilang polos): baris command + output keluar bertahap fade + slide-up (`AnimatePresence` exit, `CLEAR_EXIT_MS`/`CLEAR_STAGGER_S`, kaskade atas→bawah) dan teks `clear` ikut memudar; hanya `transform`/`opacity`, `prefers-reduced-motion` tetap statis.

## Phase 14 — Dev Startup Fix (Windows + OneDrive) [DONE 2026-10-01: `next dev` + `next build` verified, 48 tests pass, tsc clean]

- [x] Akar masalah "tidak mau di start": repo di bawah `OneDrive\Documents` → "Files On-Demand" mengubah isi `.next` jadi placeholder (reparse point); saat boot Next memanggil `readlink` di `recursive-delete` → `EINVAL` → `next dev`/`next build` crash sebelum Ready.
- [x] Fix: `frontend/scripts/clean-next.mjs` (Node `rmSync`, toleran reparse point) + hook `predev`/`prebuild` + `npm run clean`; hanya aktif di Windows saat path mengandung "onedrive" (override `FORCE_CLEAN_NEXT=1`), jadi setup lain tak kehilangan cache. Terverifikasi: start ulang dengan `.next` sudah ada → `✓ Ready` + `GET / 200`, tanpa EINVAL. Catatan env: `pnpm` tidak terpasang (ada `corepack`), pakai `npm`.

## Phase 15 — Dashboard Layout + Hover Palette + discord.com Errors [DONE 2026-10-01]

- [x] Layout: `app-shell.tsx` jadi shell murni (sidebar + header + slot); `page.tsx` pegang urutan search → stats → charts 2-col → ports full → subdomains/WHOIS 2-col → history/findings 2-col; semua kartu `CardHeader+CardContent`; chart `h-[240px]` + `maintainAspectRatio:false`; tabel `max-h-[320px]` scroll; satu history (`HistoryList` limit 5, row badge + progress); `PortsChartInner` grup per product top-8. Kontrak: order + card-structure + locked-height di `dashboard.test.ts`
- [x] Palet (Emerald dipertajam): token baru `--accent-hover` (dark `160 84% 55%` / light `160 100% 28%`) + tailwind `accent-hover`; semua hover netral (`slate-100/200`, `neutral-700/800`, `input`, `opacity-90`) → `hover:bg-accent-hover` / `hover:bg-accent/10` + `hover:border-accent/40` / `hover:text-accent` di button, sidebar, tabel, history, landing Nav/Hero/Cta; chart hover `accentHover/accentBarHover`. Kontrak di `palette.test.ts`; DESIGN.md Colors/Hover/Layout diperbarui
- [x] Backend discord.com: Shodan 403 (IP Cloudflare tanpa data) → pesan ramah "likely CDN/WAF IP" (401/404 dipetakan juga); `sanitize_error()` di orchestrator strip `?key=…` agar API key tak bocor via `errors[]`; crt.sh retry 3x backoff + timeout 15→30s + pesan "large zone — retry with Re-scan"; `_with_timeout` tak lagi hasilkan `TimeoutError:` kosong. Test baru: 403-tanpa-key-leak, sanitize-strip-key, crtsh-retry (BE 33 passed; 2 error tmp Windows adl env-only yang sudah dikenal)
- [x] Follow-up crt.sh 502 (skills.sh, 2026-10-01): 502 ternyata outage crt.sh-wide (example.com ikut 502) — retry diperluas ke 502/503/504 + pesan "temporarily unavailable, retry with Re-scan"; test 502-recover + 502-persistent. Scan tetap `partial` (Shodan/WHOIS tampil)
- [x] Verifikasi: BE `pytest` 30 passed (scope C) + `ruff`/`black` bersih di file tersentuh; FE `npm test` 50 passed, `tsc` bersih, `next build` OK; grep hover-netral 0 + hex hanya CDN

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

### Newly reported issues and requests (2026-10-04; not yet investigated or implemented)
- [ ] Diagnose the reported Shodan error for `162.159.138.232` (HTTP 403: no host data or plan limit); define and test clear handling for CDN/WAF IPs and plan restrictions.
- [ ] Diagnose the crt.sh timeout reported at about 15 seconds; reconcile the observed duration with the configured 30-second source timeout and the overall scan timeout before adjusting behavior.
- [ ] Diagnose Subfinder `NotImplementedError` from scan `fb852eba-4ce2-479f-8c27-47961b93d1953`; obtain the complete sanitized traceback and add a regression test for the identified cause.
- [ ] Investigate the two reported backend CI errors; capture the failed job/step names and full error output before choosing fixes. Local clean-room CI-equivalent checks passed previously, but the hosted errors are not yet explained.
- [ ] Add restrained looping decorative/background animation across the requested pages to make the UI feel less flat. Keep scan data and primary actions stationary, support reduced motion, and verify mobile performance.
- [ ] Change the database password to the value requested by the user; store it only in local/deployment secret configuration, never in the repository.

See [MANUAL-SETUP.md](./MANUAL-SETUP.md) for setup steps and prerequisites requiring local/deployment configuration.

### Scope note
The PostgreSQL-backed signup/session/protected-scan/sign-out flow was verified live and its synthetic test data was removed. Google/GitHub login was confirmed working by the user on 2026-10-04. The Alembic baseline preserves the existing schema and is verified on fresh and existing databases. Clean-room tests, Docker startup, database volume persistence, source/history secret scans, and current-build responsive/performance checks passed. Maintainer approval for the CC-BY-4.0 dependency remains an external action. Newly reported scan and hosted-CI errors and the animation request above remain pending.

## Backlog (v2, do NOT start)
- [ ] Scheduled monitoring + diff alerts
- [ ] PDF/CSV export, webhooks
- [ ] Org RBAC, Redis cache, SSE instead of polling
