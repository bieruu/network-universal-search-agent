/**
 * Reading the design tokens as RGB, for the layers that paint with WebGL
 * instead of CSS.
 *
 * WHY THIS EXISTS
 * ---------------
 * The ambient 3D scenes and the cobe globe cannot read `--accent` the way a
 * button does: three.js wants a colour, cobe wants `[r, g, b]` in 0..1, and
 * both need the value as text first. Each file used to parse the tokens for
 * itself, which is how the globe ended up sampling `--accent` and `--panel`
 * exactly once at mount — a theme toggle after that left a black sphere sitting
 * on a white page, because the observer flipped `dark` but never the colours.
 * One reader, used by every consumer, means the fix applies everywhere.
 *
 * The parse mirrors `globals.css`: the tokens are bare HSL triplets
 * (`--accent: 160 100% 45%`), not `hsl(...)` calls — Tailwind wraps them only
 * at the `--color-*` layer.
 *
 * Browser-only (`getComputedStyle`), so every caller must already be a
 * client component.
 */

export type Rgb = [number, number, number];

/** The raw value of a custom property on `<html>`, trimmed. Empty if absent. */
export function readToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * `160 100% 45%` → `[0, 1, 0.45ish]` as sRGB floats.
 *
 * Tolerates `hsl(...)` wrappers and comma separators because a token that is
 * spelled differently must not crash a decorative layer — it falls back to
 * whatever parsed, defaulting to black.
 */
export function hslTripletToRgb(triplet: string): Rgb {
  const parts = triplet
    .replace(/hsl\(|\)/g, "")
    .trim()
    .split(/[\s,]+/)
    .map(parseFloat);
  const h = parts[0] ?? 0;
  const s = (parts[1] ?? 0) / 100;
  const l = (parts[2] ?? 0) / 100;
  const k = (n: number) => {
    const r = n + h / 30;
    return r - Math.floor(r / 12) * 12;
  };

  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)];
}

/**
 * A token as RGB floats, re-read from the DOM every call.
 *
 * `fallback` is what a caller renders if the token is missing or unparseable —
 * a decorative scene must degrade to a sensible colour, never to a crash or to
 * an unthemed white blob.
 */
export function tokenRgb(name: string, fallback: Rgb): Rgb {
  const raw = readToken(name);
  if (!raw) return fallback;
  const rgb = hslTripletToRgb(raw);
  // Unparseable input yields NaN, and a NaN colour shows up as black — which
  // reads as "the theme broke" rather than as "the token was absent".
  return rgb.some((c) => !Number.isFinite(c)) ? fallback : rgb;
}

/** Linear blend: `t = 0` → `a`, `t = 1` → `b`. */
export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * A CSS colour string three.js can parse, e.g. `rgb(0, 229, 155)`.
 *
 * Commas, not spaces: three's `Color.setStyle` splits `rgb()` on commas, and a
 * space-separated triplet parses as a single component and comes out grey. The
 * values are sRGB — the same space the tokens are authored in — which is what
 * three expects before it converts to its working space.
 */
export function rgbCss(c: Rgb): string {
  const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return `rgb(${byte(c[0])}, ${byte(c[1])}, ${byte(c[2])})`;
}
