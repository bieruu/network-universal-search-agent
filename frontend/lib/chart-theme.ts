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
