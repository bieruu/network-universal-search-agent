# DESIGN.md — Design Reference (Locked)

> Acuan visual untuk landing + dashboard. Stack aktual: Next.js 14 App Router, Tailwind v3 (`darkMode: "class"`), shadcn-minimal `components/ui`, Chart.js, `motion/react` (terinstal), `next/font` (Space Grotesk + JetBrains Mono). Image-gen tidak ada di env → picsum placeholder + slot TODO, lihat §8.

## 1. Design Read & Dials

- **Read:** B2B SaaS landing + secure dashboard for security analyst, dark-hacking eksperimental, Tailwind + shadcn.
- **Dials:** `DESIGN_VARIANCE: 9 / MOTION_INTENSITY: 8 / VISUAL_DENSITY: 4`
- **Theme lock:** dark-only. `<html class="dark">` di `frontend/app/layout.tsx:11` jangan dicabut. Tidak ada section light di tengah page.

## 2. Tokens (map ke kode saat ini)

Base ada di `frontend/app/globals.css:5-12`:
- `--background: 222 47% 7%` (off-black, bukan `#000`), `--foreground: 210 40% 96%`
- Pertahankan. Jangan pakai pure `#000/#fff`.
- Landing memakai dark-lock `#0a0f14` (surface `#0d1319` terminal, `#0c1117` How-it-works) — lihat `frontend/app/page.tsx:21`.

Accent (satu saja, kunci untuk seluruh page):
- **Final:** Electric Emerald `#00E59B` — teks hitam di atasnya untuk kontras AA (CTA `bg-[#00E59B] text-black`).
- **Larangan:** ungu AI-glow default, gradient text besar, outer glow. Accent hanya untuk CTA primer, status OK, satu highlight terminal.
- Neutral: Zinc/Slate dingin. Jangan campur warm-gray + cool-gray dalam satu page.

Shape & depth:
- Satu skala radius: cards `rounded-2xl (16px)`, buttons `rounded-full`, inputs `rounded-lg (8px)`. Dokumentasikan bila menyimpang.
- Shadow tint ke background hue, tidak ada drop-shadow hitam pekat di dark.
- z-index hanya untuk nav sticky, modal, overlay, grain. Jangan spam `z-50`.

Tipografi:
- Final: `Space Grotesk` (body/display) + `JetBrains Mono` (angka/terminal/logo) via `next/font` dengan `display:swap` — lihat `frontend/app/page.tsx:2,16-17`. `Inter` hanya bila minta Linear-tenang.
- Hero: `text-4xl md:text-5xl lg:text-6xl tracking-tighter leading-none`, H1 `max-w-[22ch]` (deviasi dari 2-baris baku agar tidak orphan), max 2 baris. Subtext max 20 kata, `max-w-[65ch]`.
- Semua angka dashboard/landing: `font-mono`. Dilarang serif campur (`Fraunces`/`Instrument_Serif`) untuk emphasis — pakai italic/bold satu family.

## 3. Layout System

- Container: `max-w-7xl mx-auto` (landing), `max-w-5xl` (dashboard). Breakpoints `sm/md/lg/xl/2xl` standar.
- Hero: split 50/50, `min-h-[100dvh]` (jangan `h-screen`), `pt` max `pt-24`. Isi max 4 elemen teks: eyebrow (opsional, max 1) + H1 + subtext + CTA (1 primer + max 1 sekunder). Logo wall, bullets, avatar row → pindah ke bawah hero.
- Nav: satu baris di desktop, tinggi 64–72px (max 80px).
- Bento: jumlah cell = jumlah konten (5 item → 5 cell, mis. hero+4). Minimal 2–3 cell punya variasi visual (image/tint/pattern), bukan 6 kartu teks polos.
- Larangan pengulangan: satu family layout max 1x per page; zigzag image+text max 2 section berurutan; eyebrow max 1 per 3 sections; split-header kiri-H1/kanan-paragraf dilarang sebagai default.

Sections landing (urutan kunci):
1. Nav → 2. Hero split + terminal preview nyata → 3. Logo strip (di bawah hero) → 4. Bento 5 (Shodan, crt.sh, WHOIS, trends, auth/audit) → 5. How it works (numbered, beda family) → 6. Security strip → 7. CTA + footer.

## 4. Components (shadcn-minimal)

- Hanya dari `frontend/components/ui/*` (button, card, badge, input, skeleton, table). Tidak ada inline `style` untuk tema.
- States wajib: loading = `Skeleton` seukuran layout akhir (bukan spinner generik); empty = komposisi rapi + cara mengisi; error = inline/badge, toast hanya transient.
- CTA: 1 label per intent di seluruh page (`Open dashboard` dipakai di nav+hero+footer, bukan variasi `Get started/Try free`). Label max 3 kata, 1 baris di desktop, kontras AA (emerald + teks hitam lolos; putih di atas emerald terang gagal — audit tiap CTA).
- Form: label di atas, helper opsional, error di bawah, `gap-2`. Tidak ada placeholder-as-label.
- Charts: Chart.js saja via `react-chartjs-2`, `next/dynamic ssr:false`, label aksesibel, responsif.

## 5. Hacking Motif (pakai hemat)

- Terminal window nyata (mini `OverviewCards` + baris `$ scan example.com`), bukan div fake screenshot. Scanline/grain hanya di `fixed inset-0 pointer-events-none` pseudo-element, jangan di container scroll.
- Satu marquee max per page (jika dipakai). Motion harus termotivasi: hierarchy, storytelling, feedback, transisi state.
- Dilarang: custom cursor, neon outer-glow default, fake terminal dari kotak div + teks palsu.

## 6. Motion Spec

- Library: `motion/react` (terinstal, `frontend/package.json`). Dilarang `window.addEventListener("scroll")`; pakai `useScroll`/`whileInView`/IntersectionObserver.
- Nilai kontinu (mouse/scroll) via `useMotionValue`/`useTransform`, bukan `useState`.
- Hanya animasikan `transform` + `opacity`. Spring mis. `type:"spring", stiffness:100, damping:20`.
- Wajib `useReducedMotion()` / `@media (prefers-reduced-motion: reduce)` untuk semua motion di atas intensitas 3 — collapse ke statis.
- Terminal hero (`TerminalTyper.tsx`): ketik-per-karakter command (28ms/char) → cetak output sekuensial (320ms/baris) → kursor berkedip; `useReducedMotion` = statis penuh; `aria-live="polite"`; teks penuh tetap ada di SSR (`!mounted` branch) untuk SEO/no-JS. Window memakai `role="log"`, bukan `role="img"`.

## 7. Aksesibilitas & Perf

- Kontras AA body (4.5:1), AAA target hero. Toggle light tidak ada (dark-lock) — tidak perlu dual-mode, tapi hormati `prefers-reduced-motion` dan `prefers-reduced-transparency` (sediakan fallback solid untuk glass).
- LCP <2.5s: hero visual `next/image priority`, reserve space (CLS <0.1), lazy-load di bawah fold. Fonts via `next/font` + `display:swap`, jangan `<link>` Google Fonts.
- Keyboard nav Radix/shadcn, `aria-label` charts dan terminal, fokus terlihat.

## 8. Image Strategy (jujur terhadap env)

- Tidak ada image-gen tool di env ini → prioritas 2: foto nyata. Sementara: `https://picsum.photos/seed/{slug}/{w}/{h}` dengan seed deskriptif (`server-rack`, `tls-certs`, `soc-analyst`) + slot `<!-- TODO: ganti foto asli -->` (atau `{/* TODO: ganti foto asli */}` di JSX).
- 3 slot terpasang: bento server-rack (800×600), bento tls-certs (800×600), how-it-works soc-analyst (800×1000). Hero memakai terminal nyata, bukan foto. Halaman teks saja = belum selesai.
- Logo wall: SVG Simple Icons (`https://cdn.simpleicons.org/{slug}/00E59B`) untuk Next.js/FastAPI/PostgreSQL (logo-only); Shodan/crt.sh/WHOIS jadi monogram teks mono (deviasi: CDN Simple Icons 404 untuk slug `shodan`, jadi monogram — bukan wordmark teks polos).

## 9. Copy Rules

- Headline ≤8 kata, sub ≤25 kata. Satu register copy per page (teknis-mono, jangan campur editorial + marketing).
- Dilarang angka presisi palsu (`92%`, `4.1×`) kecuali data nyata atau label mock. Quote max 3 baris, kutip tipografis (“ ”), atribusi nama+role.
- Self-audit tiap string sebelum ship; ganti kalimat AI-puitis yang tidak jelas dengan kalimat fungsional polos.

## 10. File Map Phase 5 (as-built)

- `frontend/app/page.tsx` (public, dark-lock `#0a0f14`, fonts next/font) + `frontend/app/_components/landing/{Nav,Hero,TerminalTyper,Reveal,LogoStrip,FeatureBento,HowItWorks,SecurityStrip,CtaFooter}.tsx`
- Token di `frontend/app/globals.css`, tema sekali di `frontend/app/layout.tsx` (`<html class="dark">`). Charts tetap di dashboard, bukan landing.
- Terinstal: `motion` + `@phosphor-icons/react` (satu family ikon, `weight="regular"` konsisten, `size` 20/22).
- Deviasi tercatat: (1) Shodan/crt.sh/WHOIS = monogram mono, bukan ikon CDN (Simple Icons 404); (2) H1 `max-w-[22ch]` agar ≤2 baris tanpa orphan; (3) 0 marquee di seluruh landing (motion budget dipakai untuk Reveal + terminal typing); (4) terminal window `role="log"` + `aria-live`, bukan `role="img"`.

## 10b. File Map Restyle Login + Dashboard (planned — belum dieksekusi, tanpa ubah kode app)

- Primitif baru di `frontend/components/ui/` (aditif, jangan timpa yang ada): `avatar, label, progress, separator, tooltip, sheet`. Extend aditif: `card` (+Header/Content/Description/Footer), `button` (+size icon, varian ghost/secondary/destructive/link), `badge` (+secondary). API lama (`buttonClasses`, `Badge` minimal) tetap jalan.
- Login: `frontend/app/(auth)/sign-in/_components/modern-animated-sign-in.tsx` (teradaptasi, lihat §12) + rute `frontend/app/(auth)/sign-in/page.tsx` di-wire ke `@/lib/auth-client`.
- Dashboard: `frontend/components/ui/app-1-utils/{app-1-sidebar.tsx, app-1-data.ts}` (ditulis dari nol, data OSINT) + `frontend/app/(dashboard)/dashboard/_components/app-shell.tsx` (adaptasi App1). Komponen OSINT existing (`TargetSearch, ScanStatus, OverviewCards, PortsTable, SubdomainsTable, WhoisCard, HistoryList, *Chart`) pindah ke grid shell, tidak dibuang.
- Fondasi: `frontend/lib/utils.ts` (`cn` dukung objek/conditional), `frontend/tailwind.config.ts` (colors dari token lama via `hsl(var(...))`, `boxShadow.input`, animasi+keyframes `ripple`/`orbit`), `frontend/app/globals.css` (tambah `--skeleton/--btn-border/--input/--radius` + `.g-button`). Token §2 utuh, tidak ada nilai yang diganti.

## 11. Pre-Flight (gagal satu = belum ship)

- [x] Hero muat 1 viewport, H1 ≤2 baris, CTA terlihat tanpa scroll
- [x] Eyebrow ≤1/3 sections, marquee ≤1 (aktual: 0), layout family ≥4 untuk 8 sections
- [x] Semua CTA 1-baris, kontras AA, satu label per intent (`Open dashboard`)
- [x] Dark-lock konsisten, tidak ada section light nyasar
- [x] Motion jalan + reduced-motion statis, hanya transform/opacity (Reveal + TerminalTyper, `useReducedMotion` di keduanya; kontrak di `lib/landing.test.ts`)
- [x] SSR content ada (curl/build prerender: semua section + teks terminal penuh), `/dashboard`→307 live
- [ ] Lihat di 390px + 1440px, Lighthouse LCP/CLS lolos, tidak ada string rusak (desktop screenshots di `public/evidence/`; 390px + Lighthouse masih manual)

## 11b. Pre-Flight Restyle Login + Dashboard (gagal satu = belum ship)

- [ ] Login: 1 CTA primer emerald pill, form ikut §4 (label atas, error bawah, `gap-2`), orbit + ripple hanya transform/opacity + reduced-motion statis, tanpa CDN/ungu-biru/log, wiring `authClient` + redirect `/dashboard` jalan, cookie dev tetap valid
- [ ] Dashboard: sidebar + header sticky 64px, 4 stat cards data scan nyata (font-mono, tanpa angka palsu), chart tren risk via Chart.js `ssr:false`, tabel/kartu OSINT existing tetap render + partial/empty states utuh
- [ ] Semua page: font Space Grotesk + JetBrains Mono global, dark `#0a0f14` konsisten, `tsc` + `npm test` + `next build` lolos, screenshot dark `public/evidence/` (login, dashboard)

## 12. Restyle Spec Login + Dashboard (locked — keputusan user 2026-09-29)

Keputusan terkunci: (1) chart tetap **Chart.js** (tanpa `recharts`, sesuai AGENTS.md); (2) dashboard = **shell App1 + data OSINT penuh** (bukan shell saja); (3) ikon login **lucide semua** (tanpa `cdn.21st.dev`, tanpa `remotePatterns`).

Login (`modern-animated-sign-in`, adaptasi wajib sebelum pakai):
- Accent: glow input `#3b82f6` → `#00E59B`; `boxColor` default `#5046e6` → `var(--skeleton)`; teks orbit + header ikut register teknis-mono ("Universal Search", bukan "Animated Login").
- Ikon: 9 ikon orbit + logo Google diganti `lucide-react` (mis. `ShieldCheck, Server, Globe, Key, Eye, Activity, Database, Bell, Search`; tombol Google pakai `Chrome`). Tidak ada `next/image` remote.
- Form: `grid-cols-${fieldPerRow}` dinamis → hardcode; hapus `console.log`; hapus tombol "Forgot password?" (tidak ada rutenya); validasi email/password tetap, error via `errorField`.
- Motion: `BoxReveal` + orbit pakai `useReducedMotion` fallback statis; hanya transform/opacity. Panel kiri (orbit) `max-lg:hidden`, kanan form `max-lg:w-full` — responsif 390px ikut pre-flight §11b.
- Wiring (tanpa ubah kontrak auth): submit → `authClient.signInEmail` → ok? `router.push('/dashboard')` : `errorField="Sign-in failed"`; tombol Google → `authClient.signInOAuth`. Alur cookie dev di README tetap berlaku (stub tidak set cookie).

Dashboard (adaptasi App1 → OSINT):
- Shell: `SidebarProvider + App1Sidebar + SidebarInset` (pertahankan `min-w-0` fix), header sticky `h-16` (trigger, judul "Welcome back" → nama target/scan aktif, tombol search/notif, avatar).
- 4 stat cards → Open ports / Services / Vulns / Subdomains dari scan aktif (tabular-nums mono, hint = delta vs scan sebelumnya, bukan "+2 from last month" palsu).
- Area chart → `RiskTrendChart` existing (Chart.js, last-10-scans) di `Card` App1; tidak ada `recharts`.
- Dua kartu bawah → Recent scans (badge status `completed|partial|failed`, risk bar via `Progress`) + Latest findings (ganti activity generik). Klik scan → `reopen` snapshot immutable (kontrak existing dipertahankan).
- Sidebar nav: Dashboard (`/dashboard`), Sign in (`/sign-in`), section Sources (Shodan/crt.sh/WHOIS sebagai monogram, bukan link mati). Ikon satu family (`lucide-react`, `strokeWidth` konsisten) — beda dari landing (`@phosphor-icons`) dan dicatat sebagai deviasi yang diizinkan khusus dashboard shell.
- Larangan: angka presisi palsu (§9), ungu/biru accent (§2), `dangerouslySetInnerHTML` (sudah ada di shadcn-chart? tidak dipakai — chart tetap Chart.js, abaikan file `shadcn/chart` dari paste-an).

Batasan eksekusi (supaya tidak merusak yang jalan):
- Aditif saja: tidak ada overwrite `components/ui/{button,badge,card,input}.*`; tidak ada ganti nilai token §2; tidak ada lib chart baru; tidak ada folder top-level baru.
- Verifikasi: `tsc --noEmit` + `npm test` (tambah test kontrak login: tanpa log/CDN/ungu-biru) + `next build` + screenshot `public/evidence/` (login, dashboard, dark).
