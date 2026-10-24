"use client";

import { useEffect, useState } from "react";

// Chart.js colors resolved from the global CSS tokens, so charts follow the
// active theme (dark/light) instead of Chart.js grey defaults. Tokens store
// bare channels ("160 100% 45%"), so wrap with hsl() + optional alpha here.
function channels(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function paint(name: string, alpha?: number): string {
  const c = channels(name);
  return alpha === undefined ? `hsl(${c})` : `hsl(${c} / ${alpha})`;
}

export function chartPalette() {
  return {
    accent: paint("--accent"),
    accentHover: paint("--accent-hover"),
    accentSoft: paint("--accent", 0.16),
    accentBar: paint("--accent", 0.75),
    accentBarHover: paint("--accent-hover", 0.9),
    grid: paint("--btn-border", 0.7),
    tick: paint("--muted"),
    // Tooltip chip surfaces. Chart.js defaults its tooltip to rgba(0,0,0,0.8)
    // with white text, which is a black chip pasted over the light dashboard -
    // it is canvas-drawn, so the themed `components/ui/tooltip.tsx` never
    // reached it. These two carry the same tokens a DOM chip uses.
    surface: paint("--background"),
    border: paint("--btn-border"),
    ink: paint("--foreground"),
  };
}

/**
 * Tooltip options for every chart, from the palette above.
 *
 * One helper rather than a hand-written block per chart: the two charts would
 * otherwise drift the way duplicated copy always does here, and the third
 * chart added later would silently default back to black.
 */
export function chartTooltipOptions(pal: ReturnType<typeof chartPalette>) {
  return {
    backgroundColor: pal.surface,
    titleColor: pal.ink,
    bodyColor: pal.ink,
    borderColor: pal.border,
    borderWidth: 1,
    padding: 8,
    cornerRadius: 6,
  };
}

// Bumps on every html class flip (ThemeToggle), so charts re-render with the
// new theme's colors instead of going stale after a toggle.
export function useThemeTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const ob = new MutationObserver((records) => {
      if (records.some((r) => r.attributeName === "class")) setTick((t) => t + 1);
    });
    ob.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => ob.disconnect();
  }, []);
  return tick;
}
