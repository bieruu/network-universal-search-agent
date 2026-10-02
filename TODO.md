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

## Phase 16 — Pre-push Security Audit [TODO 2026-10-02]

- [ ] **P0 — Ganti auth stub dengan sesi Better Auth yang benar-benar diverifikasi backend.** `require_user()` tidak boleh menerima cookie hanya karena namanya memuat `better-auth.session`; verifikasi tanda tangan/penyimpanan sesi, expiry, dan identitas pengguna. Hapus login yang menerima kredensial apa pun dan cookie tetap; tolak startup produksi bila `BETTER_AUTH_SECRET` kosong atau masih default. Tambahkan tes cookie palsu ditolak, sesi valid diterima, dan konfigurasi produksi gagal tertutup.
- [ ] **P0 — Isolasi data berdasarkan pemilik.** Filter history, trend, dan detail scan memakai `user_id` terautentikasi; scan milik pengguna lain harus menghasilkan 404/403. Tambahkan tes lintas pengguna untuk ketiga endpoint.
- [ ] **P1 — Amankan konfigurasi PostgreSQL lokal.** Ganti password statis di Compose dengan env placeholder dan batasi port database ke loopback (atau jangan publish port bila tidak diperlukan); dokumentasikan kredensial dev yang aman.
- [ ] **P1 — Lengkapi pemeriksaan pra-push rahasia.** Perluas `.gitignore` untuk `.env.*` dengan pengecualian eksplisit file contoh; jalankan scanner rahasia pada working tree dan seluruh riwayat Git lokal. Jika rahasia pernah ter-commit, rotate/revoke dahulu, lalu bersihkan riwayat; periksa juga remote GitHub karena tidak tercakup audit lokal.
- [ ] **P1 — Tetapkan lisensi repo.** Pilih lisensi yang sesuai tujuan dan tambahkan `LICENSE` sebelum publikasi; pastikan hak/atribusi aset dan kode pihak ketiga.
- [ ] **P2 — Tingkatkan reproducibility dan pemeriksaan dependency.** Pin versi backend dan buat lockfile dengan workflow yang sesuai; jalankan `npm audit`/`pip-audit` dan evaluasi advisory sebelum push (audit ini tidak memastikan status CVE terbaru).
- [ ] **P2 — Tambahkan CI dan pembaruan dependency otomatis.** Jalankan lint, type-check, tests, dan build yang relevan untuk frontend/backend pada pull request; pertimbangkan Dependabot.
- [ ] **P2 — Jalankan ulang gate sebelum push dari setup bersih.** Verifikasi instruksi README/WORKFLOW, backend tests + `ruff` + `black`, frontend lint + `tsc` + tests + build, serta smoke-test deployment tanpa kredensial dev. Audit statis ini tidak menjalankan test suite.

## Phase 17 — crt.sh Lokal (Multi-Source CT, az7rb/crt.sh) [TODO 2026-10-02]

> Latar: crt.sh sering 502 (outage global - diverifikasi 2026-10-02: crt.sh 502 untuk example.com / google.com / discord.com). Solusi: sumber CT diambil dari tool az7rb/crt.sh v3.0.3 (https://github.com/az7rb/crt.sh) yang memanggil 4 sumber CT paralel; saat diverifikasi certspotter / crt.name / shodan-ctl semuanya 200, jadi scan tidak lagi bergantung pada satu titik gagal. Raw JSON masuk cache SQLite (TTL); snapshot ternormalisasi tetap ke Postgres `scans.result_snapshot`.

- [ ] **Toolchain - build binary dari source.** `git clone https://github.com/az7rb/crt.sh` lalu `cd crt.sh` lalu `go build -ldflags "-X main.version=3.0.1" -o crt.sh .`. `go.mod` menuntut **Go 1.26.x** (toolchain go1.26.8) dan Go belum terpasang di mesin ini -> pilih: (a) `winget install GoLang.Go`, atau (b) unduh `crt.sh_3.0.3_windows_amd64.zip` dari Releases. Binary tidak di-commit: simpan di `backend/tools/` + tambah ke `.gitignore`.
- [ ] **Runner subprocess.** `app/services/crt_tool.py`: jalankan binary via `asyncio.create_subprocess_exec` (tanpa shell, argumen list, path dari env `CRTSH_BIN`), parse output `-f json` (`domain` / `total` / `sources{count,duration_ms,error}` / `subdomains`), timeout + kill, cap <=500 subdomain, bersihkan stderr. Binary tidak ada -> fallback otomatis ke jalur httpx.
- [ ] **Fallback httpx (tanpa Go).** `crtsh_service.py` query 4 sumber langsung: `crt.sh/?q=%.{domain}&output=json` (field `name_value`), `api.certspotter.com/v1/issuances?domain=...&include_subdomains=true&expand=dns_names` (paginasi), `crt.name/v1/search?apex={domain}`, `ctl.shodan.io/api/v1/domain/{domain}/hostnames`. `asyncio.gather(return_exceptions=True)`, dedup, cap 500, timeout per sumber. Sebagian gagal -> tetap `completed` + info sumber yang gagal; semua gagal -> `RuntimeError` ramah.
- [ ] **Config** (`core/config.py` + `backend/.env.example`): `crtsh_bin`, `ct_sources` (default `crt.sh,certspotter,crt.name,shodan-ctl`), `ct_source_timeout=10`, `crtsh_base_url` (override/mirror), `ct_cache_ttl_hours=24`. Perbaiki bug: `scan_timeout_crtsh` sekarang dipakai dobel (timeout per-request di `crtsh_service.py` dan per-source di `orchestrator.py`) -> pisahkan per-attempt vs per-source.
- [ ] **Cache lokal.** Hasil CT di-cache di SQLite TTL 24h (bypass `force=true` sudah ada) -> query kedua dan seterusnya dilayani dari disk tanpa network; snapshot tetap immutable di Postgres `scans.result_snapshot`.
- [ ] **Kontrak FE tetap.** `results.crtsh` shape lama `{domain,count,subdomains[]}` tidak berubah; `SubdomainsTable` judul + empty-state dibuat netral ("CT sources") dan hanya menyebut crt.sh bila crt.sh memang sumber yang gagal; opsi tambahan: tampilkan `sources_ok` / `sources_failed`.
- [ ] **Docker.** `backend/Dockerfile` tambah stage builder Go (atau unduh binary rilis) agar deploy tetap punya 4 sumber CT; tanpa stage baru container kehilangan fitur ini - dependency baru, perlu approval.
- [ ] **Docs.** `WORKFLOW.md` bagian 2/3/7 (build binary + env baru), `PRD.md` bagian 4 daftar sumber CT, `AGENTS.md` bagian 5 sinkronkan 15s -> nilai nyata, `README.md` struktur `backend/tools/`.
- [ ] **Tests** (`test_services.py`, `test_failure_modes.py`, tanpa internet nyata): crt.sh 502 tapi certspotter/crt.name sukses -> `completed` + subdomains terisi; semua sumber gagal -> `partial`/`failed` + pesan ramah; dedup lintas sumber; cap 500; paginasi certspotter; binary hilang -> fallback httpx. Gate: `pytest -q`, `ruff check .`, `black --check .`, `tsc --noEmit`.
- [ ] **Verifikasi live.** `discord.com` -> `completed` (subdomains terisi walau crt.sh 502); scan kedua = cache hit; grep rahasia bersih.
- [ ] **Keputusan produk (butuh jawaban sebelum koding):** sumber mana yang dipakai - `crt.sh + certspotter + crt.name` saja, atau ikut `shodan-ctl` (index CT Shodan, gratis tanpa key)?

## Phase 18 — Real-Data Completeness (stub & ilustrasi menjadi data nyata) [TODO 2026-10-02]

> Latar: hasil audit 2026-10-02 - inti scan SUDAH memakai data nyata (Shodan/crt.sh/WHOIS/DNS + Postgres + cache SQLite), tetapi masih ada 4 bagian yang stub/ilustrasi. Ingat AGENTS.md bagian 7: `backend` tidak boleh menyimpan data palsu di jalur scan; item di bawah menutup sisa celah itu. Auth sengaja TIDAK diduplikasi - sudah ada di Phase 16 P0.

- [ ] **Auth/sesi: hapus stub (prasyarat = Phase 16 P0, jangan diduplikasi).** Sisi FE belum tercatat di Phase 16: `frontend/lib/auth-client.ts` masih stub - `signInEmail/signInOAuth` menulis cookie manual `dev-session`/`dev-oauth` lalu `return {ok:true}` untuk kredensial apa pun, dan `useSession()` hardcoded `{data:null}`. Ganti dengan `createAuthClient` dari `better-auth/react`, tampilkan user nyata di UI, dan jangan biarkan `frontend/middleware.ts` hanya memeriksa keberadaan cookie.
- [ ] **Rute `dev-login` tidak boleh ikut rilis produksi.** `frontend/app/dev-login/route.ts` hanya digating `NODE_ENV !== "development"`; pastikan route ini tidak ter-bundle/terekspos pada build produksi (pindahkan ke tooling dev atau blokir di level build) + tambah tes yang menolak akses saat `NODE_ENV=production`.
- [ ] **Risk score: TLS factor masih placeholder.** `backend/app/services/risk.py:24` = `tls_factor = 0.0  # placeholder: expired/old TLS detection in v2` -> skor risiko saat ini mengabaikan sertifikat kadaluarsa/hampir kadaluarsa. Implementasi: turunkan faktor TLS dari data crt.sh (`not_before`/`not_after`) dan/atau info SSL Shodan, isi `breakdown`, plus tes (cert expired harus menaikkan skor).
- [ ] **Landing: data ilustrasi TerminalTyper/Hero.** `frontend/app/_components/landing/TerminalTyper.tsx:12-40` memuat `SCANS` contoh hardcoded (`scan example.com`, `93.184.216.34 - 2 ports`, `risk 18/100`) dan `Hero.tsx:13,73` menamainya "Sample output". Putuskan: (a) label tegas "contoh/ilustrasi" tanpa angka yang bisa disalahartikan sebagai hasil nyata, atau (b) generate dari scan nyata saat build/CI. Sinkronkan kontrak `frontend/lib/landing.test.ts`.
- [ ] **Landing: ganti foto placeholder.** `FeatureBento.tsx:53,67` dan `HowItWorks.tsx:59` masih memakai `picsum.photos/seed/...` dengan komentar `TODO: ganti foto asli`; ganti dengan aset/screenshot produk sendiri (atau hapus), lalu perbarui `frontend/lib/landing.test.ts:35-36` yang saat ini justru MEWAJIBKAN picsum + TODO tersebut.
- [ ] **Rate limit persisten (butuh approval - bertabrakan dengan Backlog "Redis cache").** `backend/app/core/rate_limit.py:11` menyimpan bucket di memori proses -> reset saat restart dan tidak berlaku lintas worker/instance; pindahkan ke Postgres/Redis dengan fallback in-memory untuk dev/test. Perubahan stack perlu persetujuan karena PRD bagian 3 (Technology Stack Locked) dan AGENTS.md bagian 7 melarang memulai Backlog v2.
- [ ] **Smoke test jaringan nyata (opsional, kaitkan dengan Phase 16 P2 CI).** Suite saat ini 100% mocked ("external network is never touched" di `tests/test_services.py`), sehingga perubahan bentuk respons upstream tidak tertangkap. Tambah job nightly/manual bergerbang env (mis. `LIVE_SMOKE=1`) yang memanggil 3 sumber sekali; gate utama tetap mocked.
- [ ] **Verifikasi penutupan fase.** Setelah dikerjakan: cookie palsu 401 / sesi valid 200 (BE) + `useSession()` menampilkan user (FE); skor risiko bereaksi terhadap cert expired; grep kode produksi untuk `dev-session`, `dev-oauth`, `picsum`, `tls_factor = 0.0` harus 0 hasil; `pytest -q && ruff check . && black --check . && tsc --noEmit && next build` hijau.

## Phase 19 - Real Auth: Google/GitHub OAuth + Halaman Sign-Up Terpisah [TODO 2026-10-02]

> Latar: `frontend/lib/auth-client.ts` masih stub (cookie manual `dev-session`/`dev-oauth`, `useSession()` hardcoded null), belum ada server Better Auth, dan daftar/masuk belum dipisah. Prasyarat keamanan: **Phase 16 P0** (backend `require_user()` verifikasi sesi nyata) dikerjakan belakangan - OAuth bisa diimplementasi dulu, tapi jangan dianggap aman sebelum P0 selesai. Kredensial OAuth belum ada: implementasi + env placeholder dulu, verifikasi live menyusul.

- [ ] **Server Better Auth (wajib, OAuth tidak jalan tanpa ini).** Install `better-auth` + `pg` (Postgres adapter) di `frontend/`; `frontend/lib/auth.ts` = `betterAuth({ emailAndPassword enabled, socialProviders: { google, github }, database: <pg pool> })` dengan tabel `user/session/account/verification` di Postgres yang sama (generate schema via `@better-auth/cli`, commit SQL-nya); `frontend/app/api/auth/[...all]/route.ts` = route handler (sign-in, sign-up, callback `google`/`github`, session, signOut).
- [ ] **Ganti stub auth-client.** `lib/auth-client.ts` -> `createAuthClient` dari `better-auth/react`: `signIn.email`, `signIn.social({provider:"google"|"github"})`, `signUp.email`, `useSession()` nyata, `signOut`; `frontend/middleware.ts` tetap redirect ke `/sign-in` (perbaikan verifikasi menyusul di Phase 16 P0).
- [ ] **Ekstrak shell auth bersama.** Panel kiri (orbit + branding) & layout sign-in pindah ke `app/(auth)/_components/auth-shell.tsx` agar sign-in dan sign-up tidak duplikat; token palet + animasi `BoxReveal`/`useReducedMotion` dipertahankan.
- [ ] **Sign-in (`/sign-in`) = masuk saja.** Email + password, tombol **Continue with Google** dan **Continue with GitHub** (GitHub belum ada - tambahkan), link "Don't have an account? Sign up" -> `/sign-up`; `callbackURL=/dashboard`.
- [ ] **Sign-up baru (`/sign-up`) = daftar saja.** Form email + password + konfirmasi password -> `signUp.email` (validasi zod, password >= 8, samakan dengan konfirmasi), tombol Google & GitHub juga, link "Already have an account? Sign in" -> `/sign-in`; sukses -> `/dashboard`.
- [ ] **Link navigasi.** Landing `Nav.tsx` + `CtaFooter.tsx` dan sidebar dashboard punya jalur ke `/sign-up` dan `/sign-in` yang konsisten.
- [ ] **Env & dokumentasi (tanpa rahasia di-commit).** `frontend/.env.local.example` tambah `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `DATABASE_URL`; README/WORKFLOW: cara buat OAuth app + redirect URI `http://localhost:3000/api/auth/callback/{google,github}` dan catatan bahwa verifikasi backend masih stub sampai Phase 16 P0.
- [ ] **Kontrak & gate.** Perpanjang `lib/login.test.ts` (github wiring, link `/sign-up`), tambah `lib/signup.test.ts` (form email+password+konfirmasi, kedua tombol OAuth, link `/sign-in`, tanpa hex `#00E59B`), `palette.test.ts` cakup sign-up; jalankan `npm test && tsc --noEmit && next build`.
- [ ] **Verifikasi live (setelah kredensial OAuth tersedia).** Login Google -> callback -> `/dashboard` dengan sesi Better Auth asli; login GitHub sama; sign-up email -> akun muncul di tabel Postgres; `dev-login` tetap terpisah. Selama kredensial belum ada, verifikasi = build + tests + alur form (tanpa panggilan OAuth nyata).

## Backlog (v2, do NOT start)
- [ ] Scheduled monitoring + diff alerts
- [ ] PDF/CSV export, webhooks
- [ ] Org RBAC, Redis cache, SSE instead of polling
