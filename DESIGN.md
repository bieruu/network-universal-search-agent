---
version: "1.0"
name: "Universal Search Landing"
description: "Dark-first SaaS landing for a passive OSINT console. Ideal for landing pages, saas. AI-ready template."
colors:
  primary: "#0A0F14"
  secondary: "#0C1117"
  tertiary: "#334155"
  neutral: "#F8FAFC"
  surface: "#FFFFFF"
  accent: "#00E59B"
typography:
  h1:
    fontFamily: Space Grotesk
    fontSize: 3.75rem
    fontWeight: 700
  body-md:
    fontFamily: Space Grotesk
    fontSize: 1rem
    fontWeight: 400
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "#000000"
    padding: 12px
---

## Overview

Dark-first SaaS landing for a passive OSINT console — Shodan ports, crt.sh subdomains, and WHOIS behind one search box. Before it had sections, it had a constraint: explain session-gated scanning to skeptics without a single fake number. So the hero doesn't illustrate the product — it performs it, typing `scan example.com` into a real terminal window and printing shaped sample output. Nothing glows, nothing gradients — one emerald accent on near-black does all the talking.

Then restraint became the system. Space Grotesk carries display and body, JetBrains Mono carries terminal lines, eyebrows, and monogram logos. Motion is rationed to two moments that earn it: section reveals and the typing terminal. Everything else is static and fast. The light theme exists as a full citizen, not an afterthought — same tokens, same components, verified pair by pair.

Tight sections, pill buttons, mono terminal — these aren't aesthetic picks from a gallery. They come from the job: credibility at a glance, one CTA label everywhere, scroll on. Anti-slop is the only honest design for a page that has to earn a security analyst's click.

- Density: 4/10 — Airy sections
- Variance: 8/10 — Expressive
- Motion: 4/10 — Subtle

- **Style:** Dark-first, Technical-mono, Restrained
- **Keywords:** saas, landing, dark-mode, mono, terminal, security, minimal-chrome
- **Era:** 2020s DevTool Marketing
- **Light/Dark:** ✓ Full (dark default, preference persisted)

## Colors

- **Off-Black** (#0A0F14) — Primary dark background (`--background: 210 33% 6%` in `frontend/app/globals.css`, exact neutral match; earlier `222 47% 7%` read blue — fixed)
- **How-It-Works Surface** (#0C1117) — Dark section band (light pair: `bg-slate-50`)
- **Terminal / Panel Surface** (`--panel`: `210 40% 98%` light / `210 32% 7%` dark ≈ `#0d1319`) — Satu token untuk terminal hero DAN kartu bento (`bg-panel`, border `neutral-200/800`): keduanya tampil identik, tidak ada surface khusus per komponen
- **Electric Emerald** (#00E59B) — Single accent. Lives ONLY in token `--accent` (`160 100% 45%` dark / `160 100% 32%` light); source uses `bg-accent` / `text-accent` / `border-accent` / `text-accent-foreground`. Only other occurrence allowed: Simple Icons CDN URL params (URLs can't use CSS vars)
- **Emerald Hover** (`--accent-hover`: `160 84% 55%` dark / `160 100% 28%` light, mapped as `accent-hover`) — Semua hover state interaktif: fill `bg-accent` → `hover:bg-accent-hover`; wash `hover:bg-accent/10` + `hover:border-accent/40` untuk outline/ghost/sidebar/table-row/nav-link; chart hover `accentBarHover`/`accentHover` dari `lib/chart-theme.ts`. Larangan: `hover:bg-slate-*`, `hover:bg-neutral-700/800`, `hover:bg-input`, `hover:opacity-90` untuk fill accent.
- **Slate Ink** (#0F172A `slate-900` / #F5F5F5 `neutral-50`) — Heading pair light/dark
- **Slate Body** (#475569 `slate-600` / #A3A3A3 `neutral-400`) — Body pair light/dark
- **Slate Caption** (#64748B `slate-500` / #737373 `neutral-500`) — Caption pair light/dark
- **White Surface** (#FFFFFF) — Primary light background (`--background: 0 0% 100%`)
- **Input / Search Field** — Bidang input pakai wash emerald tipis (`bg-accent/5`) + border `border-accent/40`; hover `border-accent/60`; fokus `border-accent` + `ring-2 ring-accent/30` + `bg-accent/10`. Semua kelas accent theme-agnostic (token `--accent` sudah beda per tema: `160 100% 32%` light / `160 100% 45%` dark) — hanya teks & placeholder yang dipasangkan `dark:` (`text-slate-900 dark:text-neutral-100`, `placeholder:text-slate-400 dark:placeholder:text-neutral-500`). Tidak ada lagi surface/border `neutral-*` monokrom di input. Berlaku di `TargetSearch` (card "New scan") dan form sign-in.

Token rules (locked):
- Fill accent + `text-accent-foreground` (black) in both themes — AA safe.
- Text/icons/borders accent via token only — never hex literals or `emerald-*`/`dark:` pairs.
- No pure `#000/#fff` surfaces in dark; no heavy black drop-shadows.
- Zinc/Slate cool neutrals only — never mix warm-gray + cool-gray on one page.
- Dials: `DESIGN_VARIANCE: 8 / MOTION_INTENSITY: 4 / VISUAL_DENSITY: 4`.

## Typography

- **Display / Hero:** Space Grotesk via `next/font` (`display:swap`, loaded once in root `layout.tsx`, applied to `<body>`) — Weight 700, `tracking-tighter leading-none`, H1 `max-w-[22ch]` (≤2 lines, no orphans)
- **Body:** Space Grotesk — Weight 400, relaxed leading, subtext max 20 words / `max-w-[65ch]`
- **UI Labels / Captions:** Space Grotesk — 0.875rem, weight 500; mono captions (`text-xs`) for eyebrow lines (`PASSIVE OSINT · SHODAN + CRT.SH + WHOIS`) and captions (`auth-gated · rate-limited · audit-logged`)
- **Monospace:** JetBrains Mono (variable `--font-landing-mono` set on `<body>` in root `layout.tsx`, consumed via Tailwind `font-mono`) — Terminal output, logo monograms (`shodan`, `crt.sh`, `whois`), API tint snippets. Serif mix (`Fraunces`/`Instrument_Serif`) banned — emphasis via italic/bold in-family.

Scale:
- Hero: `text-4xl md:text-5xl lg:text-6xl`
- H1: 2.25rem
- H2: `text-3xl md:text-4xl`
- Body: 1rem / relaxed
- Small: 0.875rem / mono 0.75rem (`text-xs`)


## Layout

- **Grid:** `max-w-7xl mx-auto`, side padding `px-4 sm:px-6`. Breakpoints `sm/md/lg/xl/2xl` standard.
- **Spacing rhythm:** Nav `h-16`; sections `py-16 md:py-24`.
- **Section vertical gaps:** `py-16 md:py-24` between bands; bento grid `gap-4`, strip rows `gap-x-8 gap-y-6`.
- **Hero layout:** Split 50/50, `min-h-[100dvh]` (never `h-screen`), `pt` max `pt-24`. Max 4 text elements: eyebrow (≤1) + H1 + subtext + CTA (1 primary + ≤1 secondary).
- **Feature sections:** Bento with cell count = content count (5 items → 5 cells: Shodan, crt.sh, WHOIS, trends, auth/audit); ≥2 cells carry visuals (2 photos + 1 tinted API strip), never plain text cards. How-it-works uses numbered rows — a different family from bento. Security strip uses icon + left-rule rows in 4 columns.
- **Mobile collapse:** Hero stacks, bento `sm:grid-cols-2 lg:grid-cols-3`, strips stack. All multi-column layouts collapse below 768px. No horizontal overflow.
- **z-index contract:** base (0) / sticky-nav (40) / overlay (grain, pointer-events-none). No `z-50` spam.

Section order (locked): Nav → Hero split + real terminal → Logo strip → Bento 5 → How-it-works → Security strip → CTA + footer.

Dashboard order (locked, `dashboard/page.tsx` owns it; `app-shell.tsx` is a pure shell: sidebar + sticky `h-16` header + slot): Search card (TargetSearch + ScanStatus + `errors[]`) → stats grid (2→4 col) → charts grid (`PortsChart | RiskTrendChart`, `lg:grid-cols-2`, chart height locked `h-[240px]` + `maintainAspectRatio:false`) → `PortsTable` full width → `SubdomainsTable | WhoisCard` (`lg:grid-cols-2`, tables `max-h-[320px]` scroll) → `HistoryList | Latest findings`. All cards share `CardHeader (Title + Description) + CardContent`; one history list only (no duplicate Recent scans).


## Elevation & Depth

Flat surfaces, token borders, emerald tint wash (`bg-accent/5`), mono terminal window with real scan text — depth comes from layering restraint, not shadows.

- **Physics:** Spring `type:"spring", stiffness:100, damping:20` for reveals; terminal types 28ms/char → prints lines every 320ms → blinking cursor, then loops 3 sample targets — typing `clear` then wiping the screen out (staggered fade + `y:-6` slide-up, ~220ms/line, 45ms top-to-bottom cascade) so the rotation reads as one continuous shell session.
- **Entry animations:** `Reveal` (`whileInView`, opacity + `y:24→0`); list cascades stagger ≤0.15s. Reduced-motion collapses everything to static.
- **Motion budget expanded (approved 2026-10-06):** full ambient layer, landing + login only, dashboard data 100% static. Transform/opacity only, every piece gated by `motion-safe:`/`useReducedMotion`/`motion-reduce:`:
  - `ScrollProgress` — emerald hairline progress bar on the sticky nav (`scaleX` spring).
  - `ParallaxField` — two accent washes drifting at different scroll speeds behind the hero (decorative, `aria-hidden`).
  - `AmbientBackdrop` — CSS-only keyframes (`ambient-drift` 26s, `ambient-pulse` 9s); rendered as a **full-bleed page-level layer** behind nav + hero (`page.tsx`, `-z-10`, `h-[100dvh]`, mask fade at bottom → no hard "cut-off" edges on wide screens); also on the CTA band + login panel; static baseline for no-JS/reduced-motion.
  - `BentoVisuals` — port-grid cells breathe with staggered `ambient-pulse`; metric bars grow via `scaleY` spring on scroll-in.
  - `RiskMeter` — How-it-works risk bar fills via `scaleX` spring on scroll-in.
  - Hover micro-interactions — CTAs and bento cards lift `-translate-y` + accent shadow, disabled under `motion-reduce:`.
  - **Looping set** (approved 2026-10-06): keyframes `bob` 4.5s / `sweep` 2.4s / `blip` 1.3s / `eq` 1.6s / `breathe` 2.6s in `globals.css`. All `motion-safe:` gated (contract-tested: zero ungated loops in landing source, including `pulse`):
    - Hero: staggered traffic-light dots + eyebrow live-ping; rotating dashed dial + ping at the terminal corner.
    - CTA + nav monogram: **`breathe` halo** — ring materializes at the edge, dissolves out to max 1.12× (never reaches neighbors); replaces the abrupt `ping`.
    - Decor: bobbing logo strip & security icons; scanline sweep across the bento port grid; equalizer bars (`scaleY` loop after grow-in); shimmer on `RiskMeter`; blinking+pinging `live` dot + breathing ops bars (HowItWorks); resting pulse on parallax washes.
    - Visibility pass: wash opacities raised (light .11 / dark .14), grid alpha up, drift 26s→14s with −30px amplitude, pulse 9s→5s; CTA hover ease softened to `duration-300 ease-out`.
- **Hover states:** accent fill → `hover:bg-accent-hover`; outline/ghost/nav/table/history rows → `hover:bg-accent/10` (+ `hover:border-accent/40` untuk bordered); text links → `hover:text-accent`; 200ms. No lifts, no glows, no slate/neutral hover fills.
- **Page transitions:** None — sticky nav + instant theme class swap.
- **Performance:** Only `transform` + `opacity` animated. No scroll listeners (`whileInView` only). Fonts via `next/font`, no Google Fonts `<link>`.


## Shapes

Base corner radius: 8px (`--radius: 0.5rem`). Cards `rounded-2xl` (16px), buttons `rounded-full` (pill), inputs `rounded-md`, terminal dots `rounded-full`, photo frames `rounded-xl`. Document any deviation.


## Components

- **Input / Search Field:** `rounded-md`, `focus:outline-none`, `transition-colors`. Border emerald tipis `border-accent/40` + wash `bg-accent/5` (mengganti `border-neutral-300/700` + `bg-white/neutral-900` yang monokrom). Hover `hover:border-accent/60`; fokus `focus:border-accent` + `focus:ring-2 focus:ring-accent/30` + `focus:bg-accent/10`; teks `text-slate-900 dark:text-neutral-100`, placeholder `placeholder:text-slate-400 dark:placeholder:text-neutral-500`. Dipakai oleh `TargetSearch` (card "New scan") dan form sign-in — satu primitive, dua tempat.
- **Primary Button:** Pill shape. `bg-accent text-accent-foreground` fill, `font-semibold`. Hover: `opacity-90`. One label per intent across the whole page (`Open dashboard` in nav + hero + footer — never `Get started`/`Try free`). Max 3 words, 1 line on desktop.
- **Secondary Button:** Pill outline (`border-neutral-300 dark:border-neutral-700`, `hover:bg-slate-100 dark:hover:bg-neutral-800`). Theme-aware in both modes.
- **Badge:** Pill outline (`border-accent/40 font-mono text-accent`) for the hero eyebrow — the single allowed eyebrow.
- **Terminal:** Real window (`role="log"`, `aria-live="polite"`), traffic dots + `osint — zsh` title bar. Full text SSR'd as no-JS baseline, typed replay after mount (`TerminalTyper`). After each sample finishes the typer types `clear` and wipes the lines out (staggered `AnimatePresence` exit, transform/opacity only) before the next of the 3 rotating targets. `dangerouslySetInnerHTML` count in landing source: 0.
- **Logo Strip:** Logo-only wall — Simple Icons CDN (`cdn.simpleicons.org/*/00E59B`) for real brands (Next.js/FastAPI/PostgreSQL); mono monograms for sources without icons (Shodan 404'd on CDN → monogram, recorded deviasi).
- **Bento Cards:** Identik dengan terminal (`bg-panel`, border `neutral-200/800`, `rounded-2xl`) + icon (`text-accent`) + title + body. No placeholder photo cells remain; visuals are abstract chart / metric / status panels only.
- **How-It-Works Rows:** Numbered `01–03` (`text-accent` mono) + title + body, top-ruled rows; motion div lives INSIDE `li` (valid list structure, Lighthouse a11y 1.0).
- **Security Items:** Icon (`text-accent`) + title + body with `border-l-2 border-accent/60`.
- **Navigation:** Sticky `h-16` + backdrop-blur. Monogram `N` (`bg-accent`) + mono wordmark, anchor links (Sources/How/Security), `ThemeToggle`, primary CTA.
- **Dashboard Sidebar Sources:** Blok "Sources" di sidebar (`app-1-sidebar.tsx`) — satu-satunya daftar sumber pasif (Shodan/crt.sh/WHOIS). Header mono eyebrow `text-accent` (menggantikan `text-slate-500 dark:text-neutral-500`), tiap baris = chip monogram emerald (`bg-accent/10 text-accent`, menggantikan `bg-input` yang monokrom) + label netral (`text-slate-600 dark:text-neutral-500`). Nav item + Log out tetap wash `hover:bg-accent/10`.
- **ThemeToggle:** Sun/Moon ghost icon-button; `localStorage['theme']` shared with the `layout.tsx` inline script; no-saved-preference defaults to **dark** in both.


## Do's and Don'ts

- No emojis in UI — Phosphor (`@phosphor-icons/react`, `weight="regular"`) only; no CDN icon scripts
- No pure black surfaces in dark — use `#0a0f14` family
- No purple/blue AI-glow, no gradient text, no outer glow, no custom cursor, no marquee (motion budget: Reveal + terminal + the approved full ambient layer — see Motion section; landing/login only)
- No hardcoded `#00E59B` / `emerald-*` in source — token utilities only
- No 3-equal-column feature layouts — bento/asymmetry only; one layout family max 1x per page; zigzag image+text max 2 sections in a row; eyebrow max 1 per 3 sections
- No split-header (left-H1/right-paragraph) as default
- No `h-screen` — use `min-h-[100dvh]`
- No AI copywriting clichés: "Elevate", "Seamless", "Unleash", "Next-Gen" — headlines ≤8 words, subs ≤25, one register per page (technical-mono)
- No fake precision stats (`92%`, `4.1×`), no testimonials-as-proof — max 3-line quote with typographic marks only if real
- No placeholder image slots or fake photo scaffolding — landing visuals must be concrete, static, and product-relevant
- No generic lorem ipsum in demos — terminal shows real-shaped sample output (3 rotating targets)
- No `Reveal`-wraps-`li` — motion div goes INSIDE `li`
- No Shodan/crt.sh calls from the browser (landing links to `/dashboard` only)

- Do keep one CTA label per intent
- Do persist theme + honor `prefers-reduced-motion` / `prefers-reduced-transparency`
- Do self-audit every string before ship; replace AI-poetic lines with plain functional ones


## Use Case

Landing pages, SaaS — marketing front page for a passive network search console. One job: earn a security analyst's click to the gated product.
