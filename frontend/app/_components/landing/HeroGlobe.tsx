"use client";

import { useEffect, useRef } from "react";
import createGlobe from "cobe";
import { CaretDown, CaretUp } from "@phosphor-icons/react/dist/ssr";
import { useReducedMotion } from "motion/react";
import { PHASE_SECONDS } from "@/lib/motion-phases";
import { mixRgb, tokenRgb, type Rgb } from "@/lib/ambient-colors";
import { cn } from "@/lib/utils";
import { DEMO_SCANS } from "./playground-samples";
import HeroFlanks from "./HeroFlanks";

/**
 * The hero's picture: a cobe globe masked into the band below the copy.
 *
 * WHAT IT REPLACED
 * ----------------
 * Two things. The node graph (hub + satellite rings, three.js) sat in this
 * band behind the copy, and before that a full-viewport torus knot sat on top
 * of the headline. Per the operator's 2026-10-14 decision, the globe that used
 * to live in its own "Interactive 3D globe" section (`GlobeSection.tsx`,
 * removed) takes that spot instead - one picture, in the hero, behind the copy.
 *
 * HONESTY
 * -------
 * The dot map is a baked-in continent outline; nothing here is scan data, and
 * the sr-only line says so. The markers are NOT locations: one marker is
 * drawn per demo target from `playground-samples.ts` (example.com and its
 * siblings - reserved, invented names), at a position derived deterministically
 * from the target's own name. Mapping a website to a coordinate would claim a
 * geography for it, so the position is arbitrary on purpose, and the sr-only
 * line says that too (the operator removed the visible caption 2026-10-15; the
 * disclosure lives in the accessibility tree now, while the grab cursor carries
 * the interactivity affordance).
 *
 * ADAPTATION NOTES (the same treatment GlobeSection got)
 * -----------------------------------------------------
 * - Colours come from the design tokens via lib/ambient-colors.ts (zero hex
 *   literals), and a MutationObserver re-reads them on every theme flip -
 *   sampling once at mount is how the globe once became a black ball on the
 *   white theme.
 * - Rotation is one revolution per PHASE_SECONDS.globe, advanced by elapsed
 *   time (dt, capped) rather than by frame count, so a 120Hz display does not
 *   spin twice as fast as a 60Hz one. `phi` (spin) and `theta` (tilt) live in
 *   refs, so a re-render cannot reset either.
 * - Under prefers-reduced-motion the rAF loop never starts: one static frame,
 *   full opacity, and drag still works because that is the visitor's own input.
 * - The canvas keeps its alpha: no background colour is painted anywhere, so
 *   the sphere sits directly on the page ("black becomes transparent").
 * - The resize listener is removed on cleanup (the pasted reference code
 *   leaked it), and `createGlobe` is wrapped in try/catch so a browser without
 *   WebGL drops the picture instead of the page.
 * - `mapBrightness` is per theme, read inside `readScene()` beside the colours:
 *   2.5 dark, 1.6 light - at 2.5 the light theme's dot map approached
 *   white-on-white. The band geometry is per breakpoint too: below lg it is an
 *   absolute overlay over the dedicated stage the hero's bottom padding carves
 *   out (pb-[25rem] / sm:pb-[30rem]); at lg and up it leaves the overlay role
 *   entirely and becomes its own grid row under both hero columns
 *   (`lg:col-span-2 lg:relative lg:h-[24rem] xl:h-[28rem]`). The disc is
 *   centered in that band at every size - bottom-centred below lg, `lg:w-[22rem]`
 *   `xl:w-[24rem]` above - and the mask fades the picture in from the 30
 *   percent mark so only the lower band of the sphere shows.
 * - WHY the band's negative z-index layer was removed (2026-10-15): painting
 *   the canvas BELOW `section` and `main` - whose border boxes cover the
 *   sphere with `pointer-events:auto` - means hit-testing never returns
 *   the canvas and the pointer handlers below never fire (proven 2026-10-15:
 *   elementFromPoint at any sphere point returned SECTION/terminal, and a real
 *   drag produced a 0-pixel diff against baseline). The layout geometry above
 *   now guarantees "never covers the copy" instead - no negative z-index: the
 *   flank decoration renders before the canvas (the sphere paints over it) and
 *   the marker labels render after it with `pointer-events: none`, so the
 *   canvas stays hittable for a drag and nothing intercepts the pointer.
 * - WHY the canvas keeps `[touch-action:pan-y]` (re-decided 2026-10-16 when
 *   vertical drag became tilt): vertical touch gestures stay PAGE SCROLL -
 *   tilt is a mouse/pen affordance. Without `pan-y` the browser's default
 *   `touch-action: auto` steals the gesture on the first move (pointercancel
 *   after one pointermove); going the other way (`touch-action: none`, needed
 *   to steal vertical touch for tilt) would trap thumb-scrolling visitors
 *   whose finger lands on the globe - the band sits inside the scroll path of
 *   a long landing page. Horizontal touch spin, the reason `pan-y` exists, is
 *   unaffected either way. A pen may attempt vertical pan; the browser then
 *   fires `pointercancel` and `onPointerEnd` cleans up, so the worst case is
 *   "pen vertical drag scrolls", i.e. today's behavior.
 * - WHY the flank decoration and the marker labels exist (2026-10-16): at lg+
 *   the sphere leaves ~450px of empty band each side, and a marker dot said
 *   nothing about which example target it was. The reticle (rings, washes,
 *   limb ticks) is built from spans and borders - token colours only, no
 *   glyphs, no glow effects - and the labels are plain mono pills positioned
 *   by CSS Anchor Positioning against cobe's own anchor divs, so the position
 *   and the fade are data bindings (`--cobe-*` vars) and no per-marker JS is
 *   involved. Browsers without `anchor-name` support render no labels at all;
 *   the sr-only line below covers the a11y tree either way.
 * - INTERACTIVE FLANKS (2026-10-16, operator): the decoration above was not
 *   enough - the operator asked for something INTERACTIVE on the band's lg+
 *   flanks, not more washes. `HeroFlanks.tsx` renders two panels inside this
 *   band root (left: the three demo targets as toggle chips; right: a readout
 *   of the pick, from the same fixtures `/demo` uses), lg+ only, outside the
 *   sphere's square wrapper, so they never cover the copy or the sphere. The
 *   selection state lives in `Hero` and arrives here as props: this component
 *   forwards it to the flanks and emphasises the marker label whose target
 *   matches it (token accent border/wash - colour only, no motion). The band
 *   root stays `pointer-events-none`; only the chips and links opt back in,
 *   and the label's `pointer-events: none` + `--cobe-*` anchor mechanics are
 *   untouched, so drag-to-spin still receives every hit over the sphere.
 */

const TAU = Math.PI * 2;

/**
 * Drag feel (module constants so the pose math reads in one place).
 *
 * Horizontal spin keeps the value it has always had (0.005 rad/px). Vertical
 * tilt is damped to 0.004 so it never outpaces the spin - full travel takes a
 * 300px drag - and clamps hard at ±0.6 rad (≈ ±34°) with NO rubber-band: a
 * rubber-band on a 3D object reads as a broken control, not a soft one. The
 * rest pose (0.3) sits inside the range, far from a pole flip (±π/2), so the
 * sphere never reads as upside down. No inertia on release and no auto-level,
 * matching phi: a globe that springs back erases the visitor's input the same
 * way resetting phi would.
 */
const PHI_PER_PX = 0.005;
const TILT_PER_PX = 0.004;
const TILT_MIN = -0.6;
const TILT_MAX = 0.6;

/**
 * How much of `--foreground` is mixed into the sphere body, and how much of
 * `--background` into the glow - GlobeSection's measured rationale, kept:
 * `--panel` alone is within one lightness step of `--background` in both
 * themes, so the body has no surface to shade and only the rim shows; a
 * full-strength accent glow reads as a neon border pasted on the page.
 */
const BODY_TINT = 0.15;
const GLOW_DILUTE = 0.55;
const MARKER_SIZE = 0.1;

/** `id` is cobe's own marker key: it names the anchor div it creates per
 *  marker (`--cobe-{id}`), which is what the visible label anchors to. */
type Marker = { location: [number, number]; size: number; color: Rgb; id?: string };

/**
 * Deterministic PRNG, seeded per target name.
 *
 * The marker layout must be identical on every mount: a fresh random spread
 * each reload would make the hero flicker between shapes and would make "is it
 * in the right place" unanswerable while you look at it.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over the name, so each target seeds differently but always the same. */
function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * One marker per demo target, at a spot derived from the target's own name.
 *
 * The coordinates are arbitrary on purpose and never represent the target's
 * (or anyone's) location - a website has no coordinates, and drawing one on a
 * map would be a fabricated geographic claim about an invented target. Hashing
 * the name keeps them deterministic (same dot, same spot, every load) while
 * staying clearly non-geographic: the caption calls them "example website
 * points at arbitrary positions".
 */
/**
 * CSS-ident-safe id: `example.com` → `example-com` (dots are not ident chars).
 *
 * One derivation feeds both ends of the label binding - cobe's anchor div
 * (`anchor-name: --cobe-{id}`) and the pill's `position-anchor` - so dot and
 * label stay in lockstep by construction instead of by a hand-kept map.
 */
function markerId(target: string): string {
  return target.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function exampleMarkers(accent: Rgb): Marker[] {
  return DEMO_SCANS.map(({ target }) => {
    const rnd = mulberry32(hashString(target));
    const lat = (rnd() * 2 - 1) * 62;
    const lng = rnd() * 360 - 180;
    return { location: [lat, lng], size: MARKER_SIZE, color: accent, id: markerId(target) };
  });
}

type Scene = {
  baseColor: Rgb;
  markerColor: Rgb;
  glowColor: Rgb;
  markers: Marker[];
  /** Per theme: 2.5 dark, 1.6 light (2.5 approached white-on-white in light). */
  mapBrightness: number;
  /** cobe's own dark flag, in the same units it takes (1 / 0). */
  dark: number;
};

/**
 * Re-reads the scene from the live DOM: colours, markers, map brightness and
 * the cobe `dark` flag - one call, so the initial `createGlobe` and every
 * MutationObserver update cannot drift apart. Sampling at mount only is how a
 * theme flip once left a black sphere on the white theme.
 */
function readScene(): Scene {
  const isDark = document.documentElement.classList.contains("dark");
  const accent = tokenRgb("--accent", [0, 0.9, 0.6]);
  const panel = tokenRgb("--panel", [0.08, 0.09, 0.11]);
  const foreground = tokenRgb("--foreground", [0.95, 0.95, 0.95]);
  const background = tokenRgb("--background", [0.05, 0.06, 0.08]);
  return {
    baseColor: mixRgb(panel, foreground, BODY_TINT),
    // cobe insists on a top-level marker colour in its options; the markers
    // below each carry the same accent themselves, so both stay in step.
    markerColor: accent,
    glowColor: mixRgb(accent, background, GLOW_DILUTE),
    markers: exampleMarkers(accent),
    mapBrightness: isDark ? 2.5 : 1.6,
    dark: isDark ? 1 : 0,
  };
}

export default function HeroGlobe({
  selected,
  onSelect,
}: {
  /** The example target the visitor picked in the flank chips, or null. */
  selected: string | null;
  /** Toggle handler forwarded to the flank chips (null clears the pick). */
  onSelect: (target: string | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const reduce = Boolean(useReducedMotion());
  const phiRef = useRef(0);
  const thetaRef = useRef(0.3); // the pose the globe has always loaded with
  const widthRef = useRef(0);
  // Imperative tilt, written by the effect below and read by the on-screen
  // buttons. The buttons exist outside the effect, and a re-render must not
  // recreate the globe to move it, so the callable is stored here.
  const tiltRef = useRef<(delta: number) => void>(() => {});

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let globe: ReturnType<typeof createGlobe> | null = null;
    // Decides whether a drag owns the globe. Declared here rather than with the
    // pointer handlers so the animation loop below can read it: rotation that
    // keeps pushing while someone is dragging feels like a fight, not like a
    // planet.
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    // Set by the IntersectionObserver below. cobe has no pause API, so
    // "off-screen" means the tick stops pushing updates; the rAF loop itself
    // stays cheap.
    let onScreen = true;

    try {
      const updateSize = () => {
        widthRef.current = canvas.offsetWidth;
      };
      updateSize();

      globe = createGlobe(canvas, {
        devicePixelRatio: 2,
        width: widthRef.current * 2,
        height: widthRef.current * 2,
        phi: phiRef.current,
        theta: thetaRef.current,
        diffuse: 1,
        mapSamples: 16000,
        // Theme state (colours, markers, `dark`, `mapBrightness`) sampled here,
        // not at module scope: the theme may change between the first render
        // and this effect running.
        ...readScene(),
      });

      const onResize = () => {
        widthRef.current = canvas.offsetWidth;
        globe?.update({ width: widthRef.current * 2, height: widthRef.current * 2 });
      };
      onResize();
      window.addEventListener("resize", onResize);

      // One revolution per PHASE_SECONDS.globe, advanced by elapsed time rather
      // than by frame count. A per-frame step made the same globe turn at a
      // different speed on every display refresh rate, and a re-render resetting
      // `phi` is why it lives in a ref. The cap keeps a backgrounded tab from
      // lurching forward when it comes back.
      let raf = 0;
      let last = performance.now();
      const tick = (now: number) => {
        const dt = Math.min((now - last) / 1000, 0.1);
        last = now;
        if (!dragging && onScreen) {
          phiRef.current += (TAU / PHASE_SECONDS.globe) * dt;
          globe?.update({ phi: phiRef.current });
        }
        raf = requestAnimationFrame(tick);
      };
      if (!reduce) raf = requestAnimationFrame(tick);

      // Theme flips change the class on <html>. `dark` alone is not enough -
      // it only re-lights the scene - so the colours (including the marker
      // accent) and `mapBrightness` are re-read from the tokens and pushed in
      // the same update. Sampling them once at mount is what left a black
      // sphere on the white theme after a toggle.
      const observer = new MutationObserver(() => {
        globe?.update({ ...readScene() });
      });
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

      // Off-screen scenes stop burning frames.
      const visibility = new IntersectionObserver((entries) => {
        for (const entry of entries) onScreen = entry.isIntersecting;
      });
      visibility.observe(canvas);

      // Drag. This runs whether or not motion is allowed: it is the visitor's
      // own input, and with rotation stopped the globe would otherwise be a
      // still image that looks broken rather than deliberately paused.
      const onPointerDown = (e: PointerEvent) => {
        dragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
      };
      const onPointerMove = (e: PointerEvent) => {
        if (!dragging) return;
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
        phiRef.current += dx * PHI_PER_PX;
        // Tilt is mouse/pen only: on touch, vertical is page scroll
        // ([touch-action:pan-y]) and the browser cancels this drag with
        // pointercancel anyway - the full tradeoff is in the header note.
        if (e.pointerType !== "touch") {
          const next = thetaRef.current + dy * TILT_PER_PX;
          thetaRef.current = Math.min(TILT_MAX, Math.max(TILT_MIN, next));
        }
        globe?.update({ phi: phiRef.current, theta: thetaRef.current });
      };
      // `pointercancel` matters on touch: a drag the browser turns into a page
      // scroll never fires `pointerup`, and without this the globe would stay
      // "dragged" - rotation stopped - until the next pointerdown.
      const onPointerEnd = () => {
        dragging = false;
      };
      canvas.addEventListener("pointerdown", onPointerDown);
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerEnd);
      window.addEventListener("pointercancel", onPointerEnd);

      // The mobile tilt buttons (below) move the same clamped pose the drag
      // moves. No `touch-action` change: the canvas keeps `pan-y`, so a thumb
      // on the sphere still scrolls the page, and these buttons are the only
      // vertical control.
      tiltRef.current = (delta: number) => {
        thetaRef.current = Math.min(TILT_MAX, Math.max(TILT_MIN, thetaRef.current + delta));
        globe?.update({ theta: thetaRef.current });
      };

      return () => {
        tiltRef.current = () => {};
        window.removeEventListener("resize", onResize);
        cancelAnimationFrame(raf);
        observer.disconnect();
        visibility.disconnect();
        canvas.removeEventListener("pointerdown", onPointerDown);
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerEnd);
        window.removeEventListener("pointercancel", onPointerEnd);
        globe?.destroy();
      };
    } catch {
      // No WebGL: the hero keeps its copy and drops only the picture.
      return;
    }
  }, [reduce]);

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[62dvh] overflow-hidden [mask-image:linear-gradient(to_bottom,transparent_0%,black_30%,black_100%)] lg:col-span-2 lg:relative lg:h-[24rem] xl:h-[28rem]">
      {/* The padded wrapper, NOT an inset on the canvas itself: a canvas is a
          replaced element, so `width:auto` on an absolutely positioned one
          takes the intrinsic size from its `width` attribute (which cobe writes
          as twice the measured box) - that is how the old section box rendered
          4800px wide once. */}
      <div className="absolute bottom-8 left-1/2 aspect-square w-[min(24rem,88vw)] max-w-full -translate-x-1/2 sm:w-[26rem] lg:bottom-6 lg:w-[22rem] xl:w-[24rem]">
        {/* Band decoration. Paint order is load-bearing: this block renders
            BEFORE the canvas, so the sphere paints over it - no z-index,
            negative or otherwise (a negative z-index put the canvas under
            section/main and killed hit-testing, proven 2026-10-15). All token
            colours; aria-hidden is the bare JSX form (the test pins the quoted
            form to the canvas alone). */}
        <div aria-hidden className="pointer-events-none absolute inset-0">
          {/* Flank washes: the AmbientBackdrop wash, scoped to this band. lg+
              only - below lg the sphere fills the band and a blurred cloud
              would clip hard at the frame edge. Percentages are relative to
              the square wrapper (the sphere), so the composition scales as
              one unit. */}
          <div className="absolute left-[-72%] top-1/2 hidden aspect-square h-[95%] -translate-y-1/2 rounded-full bg-accent/15 blur-3xl lg:block" />
          <div className="absolute right-[-72%] top-1/2 hidden aspect-square h-[95%] -translate-y-1/2 rounded-full bg-accent/15 blur-3xl lg:block" />

          {/* Ring A: static dashed orbit; its side arcs run off the frame on
              narrow viewports (band overflow-hidden), which reads as orbit,
              not clipping. */}
          <div className="absolute left-1/2 top-1/2 h-[124%] w-[124%] -translate-x-1/2 -translate-y-1/2 rounded-full border border-dashed border-accent/20" />

          {/* Ring B: the moving orbit. Translate lives on the positioning
              wrapper and rotate on the inner div (Tailwind v4 uses the
              `translate` property, the keyframes use `transform` - separate
              properties, no conflict). */}
          <div className="absolute left-1/2 top-1/2 h-[158%] w-[158%] -translate-x-1/2 -translate-y-1/2">
            {/* 104s = 2 × PHASE_SECONDS.globe - from the same table,
                deliberately not in step with the sphere. */}
            <div className="relative h-full w-full rounded-full border border-accent/10 motion-safe:animate-[spin_104s_linear_infinite]">
              <span className="absolute left-1/2 top-0 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent motion-safe:animate-blip" />
            </div>
          </div>

          {/* Crosshair ticks on the sphere's limb, equator height - wrapper
              edges, so they flank the sphere at every breakpoint and never
              clip (at 390px the band margin beside the sphere is ~23px; a w-6
              tick centered on the limb stays inside it). */}
          <span className="absolute left-0 top-1/2 h-px w-6 -translate-x-1/2 -translate-y-1/2 bg-accent/40" />
          <span className="absolute left-0 top-1/2 h-6 w-px -translate-x-1/2 -translate-y-1/2 bg-accent/40" />
          <span className="absolute right-0 top-1/2 h-px w-6 -translate-x-1/2 -translate-y-1/2 bg-accent/40" />
          <span className="absolute right-0 top-1/2 h-6 w-px -translate-x-1/2 -translate-y-1/2 bg-accent/40" />
        </div>
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          className="pointer-events-auto block h-full w-full cursor-grab active:cursor-grabbing [touch-action:pan-y]"
        />
        {/* Vertical tilt for touch, where the drag is horizontal-only because
            the canvas keeps `pan-y` for page scroll. 44px targets, phone and
            tablet only; the sphere's own edge is the natural place for them. */}
        <div className="pointer-events-none absolute right-0 top-1/2 flex -translate-y-1/2 flex-col gap-2 lg:hidden">
          <button
            type="button"
            aria-label="Tilt globe up"
            onClick={() => tiltRef.current(-0.12)}
            className="pointer-events-auto flex h-11 w-11 items-center justify-center rounded-full border border-btn-border bg-background/85 text-foreground shadow-xs transition-colors hover:bg-accent/10 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <CaretUp size={18} weight="bold" aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Tilt globe down"
            onClick={() => tiltRef.current(0.12)}
            className="pointer-events-auto flex h-11 w-11 items-center justify-center rounded-full border border-btn-border bg-background/85 text-foreground shadow-xs transition-colors hover:bg-accent/10 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <CaretDown size={18} weight="bold" aria-hidden="true" />
          </button>
        </div>
        <p className="sr-only">Use the tilt buttons to turn the globe up or down.</p>
        {/* Marker labels: rendered AFTER the canvas so they paint above the
            sphere (no z-index). Position, visibility and blur are cobe's own
            `--cobe-*` data bindings - `N` (visible) is invalid at
            computed-value time, so opacity/filter resolve to their initial
            values, while the deleted var (hidden) falls back to 0 / 8px. The
            `.cobe-label` class supplies pointer-events: none (the drag must
            receive every hit) and display: none outside @supports
            (anchor-name) - see globals.css. Bare aria-hidden again: these are
            names tied to arbitrary coordinates, not a geography we claim. */}
        {DEMO_SCANS.map(({ target }) => (
          <span
            key={target}
            aria-hidden
            className={cn(
              // Base keeps the pill's mechanics exactly as they were; the
              // selected variant strengthens border/background/text with
              // token classes only (the anchor/opacity/filter bindings in
              // `style` below are untouched - position and fade stay cobe's
              // data). Colour-only change: `transition-colors` (disabled by
              // motion-reduce), never a keyframe loop.
              "cobe-label rounded-full border px-2 py-1 font-mono text-[10px] leading-none transition-colors duration-200 motion-reduce:transition-none",
              target === selected
                ? "border-accent/70 bg-accent/15 text-accent-text"
                : "border-accent/30 bg-background/85 text-slate-600 dark:text-neutral-300",
            )}
            style={{
              positionAnchor: `--cobe-${markerId(target)}`,
              opacity: `var(--cobe-visible-${markerId(target)}, 0)`,
              filter: `blur(var(--cobe-visible-${markerId(target)}, 8px))`,
            }}
          >
            {target}
          </span>
        ))}
      </div>
      {/* Interactive flanks (operator, 2026-10-16): two lg+ panels at the
          band's own left/right edges, siblings of the sphere wrapper above -
          so they sit OUTSIDE the square, never over the sphere or the copy.
          Only they carry pointer-events-auto controls; the band root keeps
          pointer-events-none, so drag-to-spin over the sphere is untouched.
          The selection state lives in Hero and arrives as props (see the
          header note). */}
      <HeroFlanks selected={selected} onSelect={onSelect} />
      <p className="sr-only">
        Illustrative - not scan data · example website points at arbitrary positions ·
        names beside points label the example targets, not a location
      </p>
    </div>
  );
}
