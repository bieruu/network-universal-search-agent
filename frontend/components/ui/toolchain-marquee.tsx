"use client";

import * as React from "react";
import { Pause, Play } from "lucide-react";
import {
  motion,
  useAnimationFrame,
  useMotionValue,
  useReducedMotion,
} from "motion/react";

import { cn } from "@/lib/utils";

import styles from "./toolchain-marquee-utils/toolchain-marquee.module.css";

export type ToolchainItem = {
  label: string;
  icon: React.ReactNode;
  accent: string;
};

export type ToolchainMarqueeProps = Omit<
  React.HTMLAttributes<HTMLDivElement>,
  "children"
> & {
  items?: ToolchainItem[];
  stacks?: ToolchainItem[][];
  duration?: number;
  rows?: number;
  showControl?: boolean;
};

/**
 * Rows of brand marks drifting in opposite directions — one row per stack.
 *
 * This is the landing's tech-stack section: a marquee is the one place a long
 * list of tools can be shown without either truncating it or turning it into a
 * wall. What keeps it honest:
 *
 * - `stacks` decides the rows, and the row count can never exceed the number of
 *   stacks given — a marquee that pads a row out with tools the product does
 *   not use is a false claim about the product, not a layout choice.
 * - The duplicated groups are `aria-hidden`, so a screen reader reads ONE list
 *   of names rather than the same names for every copy that fills the viewport.
 * - Under `prefers-reduced-motion` the rows do not animate at all and collapse
 *   to a single copy that becomes horizontally scrollable — the content is
 *   still reachable, it just does not move.
 * - The copies are measured, not guessed: a ResizeObserver counts how many
 *   groups it takes to fill the viewport, so a wide screen never runs out of
 *   marks mid-drift and a narrow one does not render six empty groups.
 * - The icons are `aria-hidden` and the LABEL carries the name, so an icon that
 *   fails to load still leaves a readable row.
 * - Content that moves on its own has to be stoppable, so `showControl`
 *   renders a pause button. It defaults off: a caller with one short row, or
 *   with no motion at all, has nothing to stop.
 */

function ToolchainGroup({
  groupRef,
  items,
  hidden = false,
}: {
  groupRef?: React.Ref<HTMLDivElement>;
  items: ToolchainItem[];
  hidden?: boolean;
}) {
  return (
    <div
      ref={groupRef}
      className={styles.group}
      aria-hidden={hidden || undefined}
    >
      {items.map((item) => (
        <span
          className={styles.badge}
          key={`${hidden ? "copy-" : ""}${item.label}`}
          style={{ "--tool-accent": item.accent } as React.CSSProperties}
        >
          <span className={styles.icon} aria-hidden="true">
            {item.icon}
          </span>
          <span>{item.label}</span>
        </span>
      ))}
    </div>
  );
}

function ToolchainRow({
  direction,
  duration,
  items,
  paused,
  reduceMotion,
}: {
  direction: "left" | "right";
  duration: number;
  items: ToolchainItem[];
  paused: boolean;
  reduceMotion: boolean;
}) {
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const groupRef = React.useRef<HTMLDivElement>(null);
  const progressRef = React.useRef(0);
  const [copyCount, setCopyCount] = React.useState(4);
  const x = useMotionValue(0);

  React.useEffect(() => {
    const viewport = viewportRef.current;
    const group = groupRef.current;
    if (!viewport || !group || typeof ResizeObserver === "undefined") return;

    function updateCopyCount() {
      const viewportWidth = viewport?.clientWidth ?? 0;
      const groupWidth = group?.offsetWidth ?? 0;
      if (viewportWidth === 0 || groupWidth === 0) return;

      setCopyCount(Math.max(2, Math.ceil(viewportWidth / groupWidth) + 1));
    }

    updateCopyCount();
    const observer = new ResizeObserver(updateCopyCount);
    observer.observe(viewport);
    observer.observe(group);

    return () => observer.disconnect();
  }, [items]);

  React.useEffect(() => {
    if (reduceMotion) {
      progressRef.current = 0;
      x.set(0);
    }
  }, [reduceMotion, x]);

  useAnimationFrame((_time, delta) => {
    if (reduceMotion || paused) return;

    const groupWidth = groupRef.current?.offsetWidth ?? 0;
    if (groupWidth === 0) return;

    const distance = (groupWidth / Math.max(duration, 1)) * (delta / 1000);
    const progress = (progressRef.current + distance) % groupWidth;
    progressRef.current = progress;
    x.set(direction === "left" ? -progress : progress - groupWidth);
  });

  return (
    <div
      ref={viewportRef}
      className={styles.viewport}
      data-direction={direction}
    >
      <motion.div className={styles.track} style={{ x }}>
        {Array.from(
          { length: reduceMotion ? 1 : copyCount },
          (_, copyIndex) => (
            <ToolchainGroup
              groupRef={copyIndex === 0 ? groupRef : undefined}
              items={items}
              hidden={copyIndex > 0}
              key={copyIndex}
            />
          ),
        )}
      </motion.div>
    </div>
  );
}

export function ToolchainMarquee({
  className,
  duration = 22,
  items,
  rows = 3,
  showControl = false,
  stacks,
  ...props
}: ToolchainMarqueeProps) {
  const reduceMotion = Boolean(useReducedMotion());
  const [paused, setPaused] = React.useState(false);
  const rowCount = Math.max(1, Math.min(8, Math.round(rows)));
  const customStacks = stacks?.filter((stack) => stack.length > 0);
  const resolvedStacks = customStacks?.length
    ? customStacks
    : items?.length
      ? [items]
      : [];

  function togglePlayback() {
    const nextPaused = !paused;
    setPaused(nextPaused);
  }

  // No content is better than a placeholder row: a marquee that invents tools
  // to fill three rows is a false claim about what the product is built with.
  if (resolvedStacks.length === 0) return null;

  return (
    <div
      {...props}
      className={cn(styles.root, className)}
      data-slot="toolchain-marquee"
      data-reduced-motion={reduceMotion || undefined}
    >
      <div className={styles.rows}>
        {Array.from({ length: Math.min(rowCount, resolvedStacks.length) }, (_, index) => (
          <ToolchainRow
            direction={index % 2 === 0 ? "left" : "right"}
            duration={duration * (1 + ((index % 3) - 1) * 0.06)}
            items={resolvedStacks[index % resolvedStacks.length]}
            key={index}
            paused={paused}
            reduceMotion={reduceMotion}
          />
        ))}
      </div>

      {!reduceMotion && showControl && (
        <button
          className={styles.control}
          type="button"
          onClick={togglePlayback}
          aria-label={paused ? "Play tool animation" : "Pause tool animation"}
          aria-pressed={paused}
        >
          {paused ? <Play /> : <Pause />}
        </button>
      )}
    </div>
  );
}

export default ToolchainMarquee;
