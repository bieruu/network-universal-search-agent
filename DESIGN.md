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
- **Raised Card Surface** (`--card`: `210 40% 97%` light / `210 33% 8%` dark, declared in BOTH `:root` and `.dark` in `globals.css`) — the surface for components that sit on a plane of their own: the toolchain marquee badges, popovers, tooltips. Deliberately SEPARATE from `--panel` — `--panel` stays the terminal + bento surface, one token for both, and a raised badge has to be distinguishable from the flat panel it floats over. **`--card-raised`, `--surface` and `--card-shadow` were deleted (2026-10-10)** together with the macOS dock that was their only consumer; see Elevation.
- **Electric Emerald** (#00E59B) — Single accent. Lives ONLY in token `--accent` (`160 100% 45%` dark / `160 100% 32%` light); source uses `bg-accent` / `text-accent` / `border-accent` / `text-accent-foreground`. Only other occurrence allowed: Simple Icons CDN URL params (URLs can't use CSS vars)
- **Emerald Hover** (`--accent-hover`: `160 84% 55%` dark / `160 100% 28%` light, mapped as `accent-hover`) — Semua hover state interaktif: fill `bg-accent` → `hover:bg-accent-hover`; wash `hover:bg-accent/10` + `hover:border-accent/40` untuk outline/ghost/sidebar/table-row/nav-link; chart hover `accentBarHover`/`accentHover` dari `lib/chart-theme.ts`. Larangan: `hover:bg-slate-*`, `hover:bg-neutral-700/800`, `hover:bg-input`, `hover:opacity-90` untuk fill accent.
- **Slate Ink** (#0F172A `slate-900` / #F5F5F5 `neutral-50`) — Heading pair light/dark
- **Slate Body** (#475569 `slate-600` / #A3A3A3 `neutral-400`) — Body pair light/dark
- **Slate Caption** (#64748B `slate-500` / #737373 `neutral-500`) — Caption pair light/dark
- **White Surface** (#FFFFFF) — Primary light background (`--background: 0 0% 100%`)
- **Brand marks (tech stack marquee)** — the marquee's marks keep their **vendor colour** (PostgreSQL blue, Tailwind cyan), not the accent: a brand mark flattened to one colour both misidentifies the tool and wastes the one thing a mark is for. Two rules were moved rather than changed: the **Next.js glyph is near-black**, so it is the one mark that swaps for the page's own ink per theme (`--tool-nextjs` in `:root`, overridden in `.dark`); and tools with no vendor colour of their own (httpx, Better Auth, Pydantic) get none and fall back to `--accent` instead of an invented one. The dock this replaced had to ship those colours as a Simple Icons CDN param, the only place a hex literal was allowed — the marquee has **no remote image at all**, so vendor colour now lives in exactly one file, `toolchain-marquee-utils/toolchain-marquee.module.css`, and `StackStrip.tsx` carries no hex whatsoever (contract-tested). The **logo strip** (the data sources, not the frameworks) keeps the mono accent treatment — that decision stands; the two strips answer different questions ("whose records is this?" vs "what is this built with?").
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
- **Feature sections:** Bento with cell count = content count (5 items → 5 cells: Shodan, crt.sh, WHOIS, trends, auth/audit); ≥2 cells carry visuals (2 photos + 1 tinted API strip), never plain text cards. How-it-works uses numbered rows — a different family from bento. Security strip uses icon + left-rule rows in 4 columns. Tech stack (`StackStrip.tsx`) is two rows of drifting badges in `ToolchainMarquee` — one row of frontend names (Next.js, TypeScript, Tailwind CSS, Zod, Chart.js, Better Auth) and one of backend names (FastAPI, SQLAlchemy, PostgreSQL, Alembic, Pydantic v2, httpx), every one a dependency this repo really has. The heading and its caption are the section's only marker; there is no eyebrow.
- **Mobile collapse:** Hero stacks, bento `sm:grid-cols-2 lg:grid-cols-3`, strips stack. All multi-column layouts collapse below 768px. No horizontal overflow.
- **z-index contract:** base (0) / sticky-nav (40) / overlay (grain, pointer-events-none). No `z-50` spam.

Section order (locked): Nav → Hero split + real terminal → Logo strip → Bento 5 → How-it-works → Security strip → Tech stack (marquee) → CTA + footer.

Dashboard order (locked, `dashboard/page.tsx` owns it; `app-shell.tsx` is a pure shell: sidebar + sticky `h-16` header + slot): Search card (TargetSearch + ScanStatus + `errors[]`) → stats grid (2→4 col) → charts grid (`PortsChart | RiskTrendChart`, `lg:grid-cols-2`, chart height locked `h-[240px]` + `maintainAspectRatio:false`) → `PortsTable` full width → `SubdomainsTable | WhoisCard` (`lg:grid-cols-2`, tables `max-h-[320px]` scroll) → `HistoryList | Latest findings`. All cards share `CardHeader (Title + Description) + CardContent`; one history list only (no duplicate Recent scans).


## Elevation & Depth

Flat surfaces, token borders, emerald tint wash (`bg-accent/5`), mono terminal window with real scan text — depth comes from layering restraint, not shadows. No gradient surfaces, no 3-layer outer shadows on any section surface.

- **Superseded 2026-10-10 — the tech-stack dock is gone.** The three elevation rules below described `MacOsDock`, which `StackStrip` no longer renders and which was deleted outright (it was never committed: it existed only in the working tree, and after the swap nothing on the page imported it). A repo should not keep a template component whose elevation language the page forbids. The marquee that replaced it has **no tray, no drop shadow, no floor reflection, and no magnitude curve** — its badges are the same plane family as the bento cards, and its only motion is a transform on `x`. The rules are left visible below as the record of what was decided on that date, and because `--card-raised` / `--surface` / `--card-shadow` (deleted with the component) are named in them.
- ~~**Dock tray is flat on this page (2026-10-10):** `StackStrip` renders `MacOsDock` with `tone="panel"`. The tray paints `hsl(var(--panel))` — the same plane as the terminal and the bento cards — and its only shading is a spread inset hairline ring plus the inset top highlight. It carries NO outer drop shadow. A floating gradient tray under a heavy shadow is exactly what the elevation rule forbids, so on this page the dock is one layer laid on an existing panel, not a shelf hovering over it.~~ *(superseded 2026-10-10)*
- ~~**Approved deviation — icon artwork only (2026-10-10):** the dock keeps its soft icon `drop-shadow` (`--card-shadow`) and its floor reflection. That is what separates a mark from the tray it sits on; without it the artwork reads as painted on rather than placed. It is the only place on the page where a shadow is allowed, and it is bounded by the component: the tray never gets one.~~ *(superseded 2026-10-10 — there is no shadow anywhere in the marquee, so no deviation is outstanding)*
- ~~**Other dock callers unchanged:** the `dock` tone — gradient `--card-raised` + 3-layer shadow, the full macOS look — remains the component default for anyone who wants it. That default is not the landing page's concern and is not covered by the deviation above.~~ *(superseded 2026-10-10 — there are no other callers)*

- **Physics:** Spring `type:"spring", stiffness:100, damping:20` for reveals; terminal types 28ms/char → prints lines every 320ms → blinking cursor, then loops 3 sample targets — typing `clear` then wiping the screen out (staggered fade + `y:-6` slide-up, ~220ms/line, 45ms top-to-bottom cascade) so the rotation reads as one continuous shell session.
- **Playground motion:** the interactive terminal reuses the terminal spring above for printed output with a 100ms per-line cascade, inside the 150ms stagger budget — nothing new was introduced. Printed output is deliberately the only motion in a session; the mode caption switches instantly, because someone reading a scan result wants the result, not the transition.
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
- **Motion budget expanded — toolchain marquee (approved 2026-10-10):** `ToolchainMarquee` in `StackStrip` is the one piece of **continuous, self-starting** motion on the landing, and it is the explicit exception that makes the *no marquee* rule above say what it means. Scope, so the exception cannot be read as a general licence:
  - **Landing only.** Never the dashboard, never the auth screens, never a data view — a moving row next to a result being read is a row that cannot be trusted to hold still.
  - **`transform` only.** The drift is a `translateX` on one track per row, driven by `useAnimationFrame` from a *measured* group width (`offsetWidth`), never a CSS keyframe — the distance to travel is not knowable in advance, so a fake width would drift the seam apart from the marks.
  - **Duration ~22s per row**, ±6% per row so the two rows never synchronise into one block. Slow on purpose: a fast marquee reads as urgency, and this section has nothing urgent to say.
  - **Gated by `useReducedMotion()`, not by a `motion-safe:` class** — because the motion is JS-driven, a class gate would be the wrong tool and would look like a gate while doing nothing. Under reduced motion the row renders once and `.viewport` becomes a scroll container, so every name is still reachable without moving anything.
  - **Stoppable.** Content that moves on its own carries a pause button (`aria-label` + `aria-pressed`), so a visitor does not need a system-wide preference to stop it.
  - **No duty-cycle loop.** `useAnimationFrame` returns early when `reduceMotion || paused`, so a paused or reduced-motion row costs no frames at all rather than burning them to do nothing.
- **Hover states:** accent fill → `hover:bg-accent-hover`; outline/ghost/nav/table/history rows → `hover:bg-accent/10` (+ `hover:border-accent/40` untuk bordered); text links → `hover:text-accent`; 200ms. No lifts, no glows, no slate/neutral hover fills.
- **Page transitions:** None — sticky nav + instant theme class swap.
- **Performance:** Only `transform` + `opacity` animated. No scroll listeners (`whileInView` only). Fonts via `next/font`, no Google Fonts `<link>`.


## Shapes

Base corner radius: 8px (`--radius: 0.5rem`). Cards `rounded-2xl` (16px), buttons `rounded-full` (pill), inputs `rounded-md`, terminal dots `rounded-full`, photo frames `rounded-xl`. Document any deviation.

Dock deviations (`macos-dock.tsx`, deleted 2026-10-10 — kept only as the record of what its form required; no component on the page imitates it any more, so nothing below is currently binding):
- **Tray** `rounded-2xl` — matches the card radius, so a dock inside a card reads as the same surface family.
- **Icon frame / floor reflection** `rounded-[10px]` — a squircle-ish frame around artwork of variable size; the dock accepts any node and a smaller icon must centre rather than sit in a corner.
- **Built-in plate + ⌘K slot** `rounded-[22%]` — Apple's icon grid: the squircle covers ~82% of its tile with the surrounding margin transparent. Plates the dock draws itself sit on the same grid, or they read a fifth larger than the real artwork standing next to them. Percentage radius, not a px token, because the plate is sized in percentages.
- **Command menu** `rounded-xl`, menu rows `rounded-lg` — a floating sheet, not a card.

Marquee (`toolchain-marquee.tsx`) — no deviation, deliberately:
- **Badge** `var(--radius)` (8px, the base token) with `hsl(var(--btn-border))` hairline and `hsl(var(--card))` fill: the same plane family and the same radius as the bento cards, so a drifting row of badges reads as more of the page rather than a widget pasted onto it. No per-component radius, no tray, no squircle.
- **Row gap** `calc(var(--radius) * 0.75)` and badge gap `calc(var(--radius) * 0.5)` — everything is derived from the one radius token, so a radius change moves the whole component without a second number to remember.


## Components

- **Input / Search Field:** `rounded-md`, `focus:outline-none`, `transition-colors`. Border emerald tipis `border-accent/40` + wash `bg-accent/5` (mengganti `border-neutral-300/700` + `bg-white/neutral-900` yang monokrom). Hover `hover:border-accent/60`; fokus `focus:border-accent` + `focus:ring-2 focus:ring-accent/30` + `focus:bg-accent/10`; teks `text-slate-900 dark:text-neutral-100`, placeholder `placeholder:text-slate-400 dark:placeholder:text-neutral-500`. Dipakai oleh `TargetSearch` (card "New scan") dan form sign-in — satu primitive, dua tempat.
- **Primary Button:** Pill shape. `bg-accent text-accent-foreground` fill, `font-semibold`. Hover: `opacity-90`. One label per intent across the whole page (`Open dashboard` in nav + hero + footer — never `Get started`/`Try free`). Max 3 words, 1 line on desktop.
- **Secondary Button:** Pill outline (`border-neutral-300 dark:border-neutral-700`, `hover:bg-slate-100 dark:hover:bg-neutral-800`). Theme-aware in both modes.
- **Badge:** Pill outline (`border-accent/40 font-mono text-accent`) for the hero eyebrow — the single allowed eyebrow.
- **Terminal:** Real window (`role="log"`, `aria-live="polite"` on the window, never nested), traffic dots + `osint — zsh` title bar. Full text SSR'd as no-JS baseline, typed replay after mount (`TerminalTyper`). After each sample finishes the typer types `clear` and wipes the lines out (staggered `AnimatePresence` exit, transform/opacity only) before the next of the 3 rotating targets. `dangerouslySetInnerHTML` count in landing source: 0.
- **Playground (the hero terminal is interactive):** Three phases in one window, one-way. `attract` — nobody has typed, so `TerminalTyper` replays as before. `demo` — signed out and typed something: `list` reveals 3 fixed demo targets, `scan` prints **simulated** output. `live` — signed in: `list` shows the visitor's own scan history, `scan` runs the real API. The gate that makes it read like a shell: `scan` is refused until `list` has been run (`lib/playground-commands.ts`, the grammar is pure and unit-tested separately from the component). Grammar is `help` / `list` / `scan <domain>` / `clear`; a bare domain is shorthand for `scan`. **Signed out, a scan never touches the network** — there is no anonymous scan route (every backend scan endpoint calls `require_user()`), and Shodan is one shared paid key, so a signed-out "scan" answers from static fixtures. The honesty rule is therefore load-bearing and pinned by contract tests: `DEMO_NOTICE` above every simulated block, `DEMO_LIST_NOTICE` under `list`, and a permanent visible caption (`Demo — simulated output for three fixed targets` vs `Live — your scans run against the real API`). A simulated result that could read as a real one is the one unacceptable bug here. The prompt renders only after mount (a dead input is worse than no input); signed-in history is fetched client-side inside `list`, never server-rendered, so no unmasked analyst target reaches cacheable HTML. **Attention is bought with a click, not a hover.** Hover was tried and rejected: the pointer crosses the window on its way somewhere else, so merely passing over the hero blanked the output and stole the keyboard. A click is a decision. On that click the terminal wipes itself and the prompt is already waiting when the wipe finishes; clicking anywhere outside wipes again and hands the window back to the attract loop. **The clear runs on both edges** — on the way in and on the way out — because leaving without one snapped the output away and dropped the attract loop in its place, which read as a glitch rather than the terminal tidying up. Wipe values are `TerminalTyper`'s own (220ms/line, 45ms cascade). During a wipe the prompt is `disabled`, so keystrokes are dropped instead of racing the animation, and focus is replayed once it ends (a disabled input cannot hold focus). History and the `list` gate survive both edges; only the transcript and the prompt reset. **The attract loop keeps its caret and its typed `clear`** — with no session there is no real prompt to collide with, and hiding it left a dead-looking window; it is suppressed only while a session is live, when two blocks would read as two inputs again. **The prompt is the last line INSIDE the transcript**, styled like every other line, with no border and no separate field: an `<input>` in its own strip made the window read as "a terminal" sitting next to "a search box" rather than one terminal. the window is a fixed-height flex column with output stacked upward from the prompt (`mt-auto`), because an auto-height window resized the hero mid-read when the session started. The attract loop is given `suppressCaret`, which hides both its blinking block AND its own trailing `$` prompt line — otherwise the window shows two prompts and the visitor cannot tell which one takes typing. There is no painted caret beside the input; the native caret is recoloured with `caret-accent`, since a block on the far right duplicated the native one and both jumped around while typing. Shell recall is on the arrow keys: **up walks back from the newest entry**, down walks forward to an empty prompt, and the caret lands at the end. Command columns render in normal weight with their explanation one step dimmer (`Part.dim`), which is what makes `list` read as a terminal answering rather than prose pasted into monospace. The transcript scrolls on a themed `.terminal-scroll` (invisible track, thin rounded thumb in `--border`, warming to `--accent` on hover): the stock Chromium scrollbar read as a bright grey slab dropped into the near-black panel.
- **Toolchain marquee (`components/ui/toolchain-marquee.tsx`):** the landing's tech-stack section, rendered by `StackStrip`. One row per `stacks` entry, and the row count is capped at the number of stacks given — a marquee that pads a row with tools the project does not use is a false claim, not a layout choice. Empty `stacks` renders `null` rather than a placeholder row. Duplicate groups that only exist to fill the viewport are `aria-hidden`, so a screen reader reads one list of names; the icons are `aria-hidden` and the label carries the name, so a failed icon still leaves a readable row. Reduced motion renders one copy in a scroll container. Vendor colour lives in the component's own CSS module as custom properties (`--tool-*`), the only place on the page it appears.
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
- No purple/blue AI-glow, no gradient text, no outer glow, no custom cursor, no marquee **except the tech-stack strip** (motion budget: Reveal + terminal + the approved full ambient layer + the approved marquee exception — see Motion section; landing/login only). The marquee exception is bounded and dated (approved 2026-10-10): landing only, transform-only, ~22s drift, `useReducedMotion` gate rather than a class, and a pause control.
- No hardcoded `#00E59B` / `emerald-*` in source — token utilities only
- No 3-equal-column feature layouts — bento/asymmetry only; one layout family max 1x per page; zigzag image+text max 2 sections in a row; eyebrow max 1 per 3 sections (the landing spends them on the hero badge and how-it-works, so the tech-stack strip takes a heading instead)
- No split-header (left-H1/right-paragraph) as default
- No `h-screen` — use `min-h-[100dvh]`
- No AI copywriting clichés: "Elevate", "Seamless", "Unleash", "Next-Gen" — headlines ≤8 words, subs ≤25, one register per page (technical-mono)
- No fake precision stats (`92%`, `4.1×`), no testimonials-as-proof — max 3-line quote with typographic marks only if real
- No placeholder image slots or fake photo scaffolding — landing visuals must be concrete, static, and product-relevant
- No generic lorem ipsum in demos — terminal shows real-shaped sample output (3 rotating targets)
- No `Reveal`-wraps-`li` — motion div goes INSIDE `li`
- No Shodan/crt.sh calls from the browser. The landing playground reuses the existing session-gated `/api/scan` proxy for signed-in scans; there is deliberately **no anonymous scan path**, and the signed-out demo is answered from static fixtures
- **Never remove `framer-motion` — it is not a pruneable package.** This project uses `motion` v13, which still depends on `framer-motion`, so it is a real runtime dependency and not dead weight sitting in `package.json`. It was uninstalled once during the dock work and the whole landing page 500'd: `node_modules/framer-motion/dist/es/index.mjs` went with it, `motion/dist/es/react.mjs` failed to import, and `BentoVisuals.tsx` plus every landing route died with it. An unused-looking dependency that the build actually needs fails silently until the page is gone — treat `npm uninstall framer-motion` as a production change, never as cleanup

- Do keep one CTA label per intent
- Do persist theme + honor `prefers-reduced-motion` / `prefers-reduced-transparency`
- Do self-audit every string before ship; replace AI-poetic lines with plain functional ones


## Use Case

Landing pages, SaaS — marketing front page for a passive network search console. One job: earn a security analyst's click to the gated product.
