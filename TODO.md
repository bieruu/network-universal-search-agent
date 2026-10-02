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
- [x] DESIGN.md: selaraskan dengan landing yang jadi — token final (`#0a0f14`, emerald `#00E59B`), font final (Space Grotesk + JetBrains Mono via next/font), struktur section final, keputusan deviasi (Shodan jadi monogram karena CDN 404, H1 `max-w-[22ch]`, 0 marquee) — DONE 2026-09-29 (Overview/Colors/Elevation/Components as-built + manual checks kecuali 390px + Lighthouse)
- [x] Terminal hero: animasi mengetik + eksekusi layaknya terminal (ketik per karakter → cetak baris berurutan → kursor berkedip; `prefers-reduced-motion` = statis; teks tetap ada di SSR) — DONE 2026-09-29 (Hero renders `TerminalTyper`, hooks-order fix, `role="log"` + `aria-live`, kontrak di `landing.test.ts`, SSR verified via prerender `index.html`)

## Phase 7 — Login + Dashboard Restyle [DONE 2026-09-30: tsc OK, 34 tests pass (10 baru login+dashboard), `next build` OK]

> Keputusan terkunci: chart tetap Chart.js (tanpa recharts), dashboard = shell App1 + data OSINT penuh, semua ikon lucide (tanpa CDN 21st.dev). Hanya aditif: tambah primitif UI baru, extend card/button/badge tanpa mengubah API lama; token DESIGN.md utuh.

- [x] A — Fondasi: install `lucide-react` + Radix (`avatar, slot, progress, separator, tooltip, dialog, label`); upgrade `cn()` dukung objek/conditional; extend `tailwind.config.ts` (colors dari token lama via `hsl(var(...))`, `boxShadow.input`, animasi+keyframes `ripple`/`orbit`); `globals.css` tambah `--skeleton/--btn-border/--input/--radius` + `.g-button`
- [x] B — Primitif UI: tambah `components/ui/{avatar,label,progress,separator,tooltip,sheet}.tsx`; extend `card` (+Header/Content/Description/Footer), `button` (+size icon, varian ghost/secondary/destructive/link), `badge` (+secondary)
- [x] C — Login (`app/(auth)/sign-in/`): `modern-animated-sign-in.tsx` teradaptasi (accent emerald `#00E59B`, ikon lucide semua, `BoxReveal` + `useReducedMotion`, `grid-cols` hardcode, tanpa `console.log`/CDN, path import diluruskan); wire submit → `authClient.signInEmail` → `router.push('/dashboard')`, gagal → `errorField`, Google → `signInOAuth`, "Forgot password?" dibuang; panel kiri orbit + teks produk; test kontrak baru + `tsc` + `build`
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
- Browser 2026-10-01: landing/sign-in/dashboard dark+light OK, Lighthouse 1.0/1.0/1.0, bukti `frontend/public/evidence/phase9-*`. Sisa: 390px viewport + LCP/CLS.

## Phase 10 — Palette Token Alignment + Mobile Sheet Fix [DONE 2026-10-01: npm test 43 passed (2 baru), tsc clean, `next build` OK]

- [x] Migrasi semua `#00E59B` literal → utilitas token global (`bg-accent/text-accent/border-accent/text-accent-foreground`); hex hanya di `--accent` + URL Simple Icons; kontrak di `login.test.ts` + `palette.test.ts`
- [x] Fix sheet burger kosong di mobile (`max-md:flex` override `hidden`; sebab: `cn()` plain-join, `.hidden` menang atas `.flex` di cascade) + `Button` `forwardRef` untuk `asChild`; kontrak di `dashboard.test.ts`; terverifikasi di CSS produksi

## Phase 11 — One-Script Dev + Auto-Login [DONE 2026-10-01: npm test 45 passed (2 baru devlogin), tsc clean, chain terverifikasi live]

- [x] `dev.ps1` di root: 1 perintah nyalakan backend+frontend, install otomatis yang kurang (venv/deps/node_modules), reclaim port 3000/8000, tunggu sehat, buka browser; Ctrl+C matikan dua tree; murni ASCII agar lolos parser Windows PowerShell 5.1
- [x] `frontend/app/dev-login/route.ts`: dev-only (404 di production), set cookie `better-auth.session_token=dev` → 307 `/dashboard`; kontrak di `lib/devlogin.test.ts`
- [x] Verifikasi live: `/dev-login` 307 + cookie, `/dashboard` 200 tanpa bounce, `POST /api/v1/scan` 200 (auth pass-through); docs di README + WORKFLOW §4

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

## Backlog (v2, do NOT start)
- [ ] Scheduled monitoring + diff alerts
- [ ] PDF/CSV export, webhooks
- [ ] Org RBAC, Redis cache, SSE instead of polling
