"use client";

import { useEffect, useRef } from "react";
import createGlobe from "cobe";
import { useReducedMotion } from "motion/react";
import { PHASE_SECONDS } from "@/lib/motion-phases";
import { mixRgb, tokenRgb, type Rgb } from "@/lib/ambient-colors";

const TAU = Math.PI * 2;

/**
 * How much of `--foreground` is mixed into the sphere body, and how much of
 * `--background` into the glow.
 *
 * The body used to be `--panel`, which is within one lightness step of
 * `--background` in both themes: the sphere had no surface to shade, so all a
 * visitor saw was the rim. Mixing toward the foreground gives it an edge to
 * light. The glow used to be the raw accent at full strength — a neon ring
 * pasted on top of the page — so it is diluted toward the background instead,
 * and reads as light coming off the globe rather than as a border.
 */
const BODY_TINT = 0.15;
const GLOW_DILUTE = 0.55;

function readPalette(): { baseColor: Rgb; markerColor: Rgb; glowColor: Rgb } {
  const accent = tokenRgb("--accent", [0, 0.9, 0.6]);
  const panel = tokenRgb("--panel", [0.08, 0.09, 0.11]);
  const foreground = tokenRgb("--foreground", [0.95, 0.95, 0.95]);
  const background = tokenRgb("--background", [0.05, 0.06, 0.08]);
  return {
    baseColor: mixRgb(panel, foreground, BODY_TINT),
    markerColor: accent,
    glowColor: mixRgb(accent, background, GLOW_DILUTE),
  };
}

export default function GlobeSection() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const reduce = Boolean(useReducedMotion());
  const phiRef = useRef(0);
  const widthRef = useRef(0);

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
        theta: 0.3,
        dark: document.documentElement.classList.contains("dark") ? 1 : 0,
        diffuse: 1,
        mapSamples: 16000,
        mapBrightness: 2.5,
        markers: [],
        // Sampled here, not at module scope: the theme may change between the
        // first render and this effect running.
        ...readPalette(),
      });

      const onResize = () => {
        widthRef.current = canvas.offsetWidth;
        globe?.update({ width: widthRef.current * 2, height: widthRef.current * 2 });
      };
      onResize();
      window.addEventListener("resize", onResize);

      // One revolution per PHASE_SECONDS.globe, advanced by elapsed time rather
      // than by frame count. The old constant assumed 60fps, so the same globe
      // turned once every three seconds on a 60Hz screen and about twice that
      // fast on a 120Hz one — the complaint that it "spun too fast" was two
      // bugs stacked: a three-second period, and a per-frame step.
      let raf = 0;
      let last = performance.now();
      const tick = (now: number) => {
        const dt = Math.min((now - last) / 1000, 0.1);
        last = now;
        if (!dragging) {
          phiRef.current += (TAU / PHASE_SECONDS.globe) * dt;
          globe?.update({ phi: phiRef.current });
        }
        raf = requestAnimationFrame(tick);
      };
      if (!reduce) raf = requestAnimationFrame(tick);

      // Theme flips change the class on <html>. `dark` alone is not enough —
      // it only re-lights the scene — so the colours are re-read from the
      // tokens and pushed in the same update. Sampling them once at mount is
      // what left a black sphere on the white theme after a toggle.
      const observer = new MutationObserver(() => {
        const isDark = document.documentElement.classList.contains("dark");
        globe?.update({ dark: isDark ? 1 : 0, ...readPalette() });
      });
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

      // Drag. This runs whether or not motion is allowed: it is the visitor's
      // own input, and with rotation stopped the globe would otherwise be a
      // still image that looks broken rather than deliberately paused.
      const onPointerDown = (e: PointerEvent) => {
        dragging = true;
        lastX = e.clientX;
      };
      const onPointerMove = (e: PointerEvent) => {
        if (!dragging) return;
        const delta = e.clientX - lastX;
        lastX = e.clientX;
        phiRef.current += delta * 0.005;
        globe?.update({ phi: phiRef.current });
      };
      const onPointerUp = () => {
        dragging = false;
      };
      canvas.addEventListener("pointerdown", onPointerDown);
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);

      return () => {
        window.removeEventListener("resize", onResize);
        cancelAnimationFrame(raf);
        observer.disconnect();
        canvas.removeEventListener("pointerdown", onPointerDown);
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        globe?.destroy();
      };
    } catch {
      // No WebGL: the section keeps its copy and drops only the picture.
      return;
    }
  }, [reduce]);

  return (
    <section className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-10 px-6 py-20 md:grid-cols-2 md:gap-14">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Interactive 3D globe</h2>
        <p className="mt-4 text-base leading-relaxed text-muted-foreground">
          Drag to spin it. This dot-map is drawn in your browser from a baked-in
          outline of the continents — it is decoration, and nothing from your
          search is plotted on it.
        </p>
        <p className="mt-3 text-base leading-relaxed text-muted-foreground">
          It is here for scale. The records behind a single domain —
          certificates, registrations, open services — are spread across the
          whole internet, and this tool reads them from public records without
          sending packets to your target&apos;s host.
        </p>
        <p className="mt-5 font-mono text-xs text-muted-foreground">
          Illustrative — not scan data · drag to spin
        </p>
      </div>
      {/* The picture is subordinate to the paragraph: it sits in its own box
          with a gutter, so the rim is never sliced by the column edge.
          The gutter is a padded wrapper, NOT `inset` on the canvas itself —
          a canvas is a replaced element, so `width:auto` on an absolutely
          positioned one takes the intrinsic size from its `width` attribute
          (which cobe writes as twice the measured box) and ignores `right`,
          which is how this box came to render 4800px wide once. */}
      <div className="relative mx-auto aspect-square w-full max-w-[26rem] overflow-hidden">
        <div className="absolute inset-6">
          <canvas ref={canvasRef} aria-hidden="true" className="block h-full w-full" />
        </div>
      </div>
    </section>
  );
}
