"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { TerminalSample } from "./terminal-lines";
import { DEMO_SCANS } from "./playground-samples";

// Terminal typing effect: the command is typed char-by-char, then output
// lines appear sequentially like a real execution. Between two samples it
// types `clear`, then the screen wipes itself out (staggered fade + slide-up)
// before the next scan, so the rotation reads like one continuous shell
// session instead of an abrupt jump. Static full output when reduced motion
// is on; full text is also SSR'd (see Hero fallback).
//
// The samples themselves live in `playground-samples.ts` because the same three
// are what a signed-out visitor gets from the playground's `scan` command — two
// copies of the same data is a drift trap.
const SCANS = DEMO_SCANS;

const CHAR_MS = 28;
const LINE_PAUSE_MS = 320;
const LOOP_DELAY_MS = 1000; // pause after output before typing `clear`
const CLEAR_CMD = "clear";
const CLEAR_PAUSE_MS = 650; // hold `clear` on screen (the "enter" beat)
const CLEAR_BLANK_MS = 520; // wipe + blank beat before the next sample
const CLEAR_EXIT_MS = 0.22; // per-line clear (wipe) animation duration, seconds
const CLEAR_STAGGER_S = 0.045; // top-to-bottom cascade between cleared lines

// `sample` is the signed-in case: the one real scan for this analyst. It has
// the exact same shape as an entry in SCANS, so nothing below branches on
// which mode it is — only on whether there is anything to rotate to. A real
// result is never cleared and replayed: it types once and stays.
// `suppressCaret` exists for the one place this component is no longer the only
// thing on screen. On the landing page the hero terminal became interactive:
// `PlaygroundTerminal` renders this attract loop ABOVE a real prompt the visitor
// types into. Two blinking blocks then read as two inputs — one of them not
// accepting anything. So the interactive host suppresses this one and lets the
// real prompt own the caret. Default is unchanged, so every other caller keeps
// exactly the motion this file documents. What is NOT suppressed is the caret's
// width: this file's caret is a thin 2px bar, matched to the native caret the
// real prompt draws, so the two halves of the window never disagree about what a
// cursor looks like. The wide block it used to be is the same duplication bug in
// miniature, so it was narrowed rather than kept.
export default function TerminalTyper({
  sample,
  suppressCaret = false,
  onSnapshot,
}: {
  sample?: TerminalSample | null;
  suppressCaret?: boolean;
  /**
   * Reports exactly what is on screen right now.
   *
   * The interactive host needs this because the attract loop's output is this
   * component's own internal state, not the host's transcript entries — so on
   * the first click the host had nothing to animate away and the window simply
   * went blank. Reporting the visible lines lets the host seed them as ordinary
   * entries and wipe the text the visitor was actually looking at.
   */
  onSnapshot?: (lines: string[]) => void;
}) {
  const reduce = useReducedMotion();
  const scans = useMemo<readonly TerminalSample[]>(() => (sample ? [sample] : SCANS), [sample]);
  const rotating = !sample;
  const [mounted, setMounted] = useState(false);
  const [scanIndex, setScanIndex] = useState(0);
  const [chars, setChars] = useState(0);
  const [lines, setLines] = useState(0);
  // null = idle; 0..CLEAR_CMD.length = typing `clear`;
  // CLEAR_CMD.length + 1 = screen blanked, waiting for the next scan.
  const [clearChars, setClearChars] = useState<number | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    const scan = scans[scanIndex] ?? scans[0];
    if (reduce) {
      setChars(scan.command.length);
      setLines(scan.output.length);
      setClearChars(null);
      return;
    }

    // 1) Type the scan command, char-by-char.
    if (clearChars === null && chars < scan.command.length) {
      const t = setTimeout(() => setChars((c) => c + 1), CHAR_MS);
      return () => clearTimeout(t);
    }
    // 2) Print the output lines sequentially.
    if (clearChars === null && lines < scan.output.length) {
      const t = setTimeout(() => setLines((l) => l + 1), LINE_PAUSE_MS);
      return () => clearTimeout(t);
    }
    // 3) Output done → hold, then start typing `clear`. A real result is
    // never wiped: it stays on screen as the record of what was found.
    if (!rotating) return;
    if (clearChars === null) {
      const t = setTimeout(() => setClearChars(0), LOOP_DELAY_MS);
      return () => clearTimeout(t);
    }
    // 4) Type `clear`, char-by-char, on the prompt line.
    if (clearChars < CLEAR_CMD.length) {
      const t = setTimeout(() => setClearChars((c) => (c ?? 0) + 1), CHAR_MS);
      return () => clearTimeout(t);
    }
    // 5) `clear` typed → hold on screen, then blank the terminal.
    if (clearChars === CLEAR_CMD.length) {
      const t = setTimeout(() => setClearChars(CLEAR_CMD.length + 1), CLEAR_PAUSE_MS);
      return () => clearTimeout(t);
    }
    // 6) Blank beat → advance to the next sample and restart from zero.
    const t = setTimeout(() => {
      setScanIndex((index) => (index + 1 === scans.length ? 0 : index + 1));
      setChars(0);
      setLines(0);
      setClearChars(null);
    }, CLEAR_BLANK_MS);
    return () => clearTimeout(t);
  }, [mounted, chars, lines, clearChars, reduce, scanIndex, scans, rotating]);

  const scan = scans[scanIndex] ?? scans[0];

  // Report exactly what is on screen right now.
  //
  // The interactive host needs this because the attract output is this
  // component's internal state, not the host's transcript. Without it the host
  // had nothing to animate away on the first click and the window simply went
  // blank — the visitor saw the text vanish rather than be cleared. The loop
  // keeps running underneath; the host only needs the current lines.
  useEffect(() => {
    if (!onSnapshot) return;
    const visible: string[] = [];
    if (chars > 0) visible.push(`$ ${scan.command.slice(0, chars)}`);
    for (const line of scan.output.slice(0, lines)) visible.push(line);
    onSnapshot(visible);
  }, [chars, lines, scan, onSnapshot]);

  // SSR + first paint + no-JS: full static text (SEO/accessible baseline).
  // After mount, the typing performance takes over from zero.
  if (!mounted) {
    return (
      <div className="space-y-1.5">
        <p className="truncate">
          <span className="text-accent">$ </span>
          <span className="text-slate-900 dark:text-neutral-100">{scan.command}</span>
        </p>
        {scan.output.map((l) => (
          <p key={l} className="truncate text-slate-600 dark:text-neutral-400">
            {l}
          </p>
        ))}
      </div>
    );
  }

  const commandDone = chars >= scan.command.length;
  const done = commandDone && lines >= scan.output.length;
  const typingClear = clearChars !== null && clearChars <= CLEAR_CMD.length;
  const blank = clearChars === CLEAR_CMD.length + 1;

  return (
    <div aria-live="polite" className="space-y-1.5">
      {/* On `clear` the live lines wipe out (staggered, top-to-bottom) instead
          of vanishing instantly — the terminal "scrolls itself" clean. */}
      <AnimatePresence>
        {!blank && (
          <motion.p
            key={`cmd-${scan.command}`}
            className="truncate"
            exit={{ opacity: 0, y: -6, transition: { duration: CLEAR_EXIT_MS, ease: "easeIn" } }}
          >
            <span className="text-accent">$ </span>
            <span className="text-slate-900 dark:text-neutral-100">{scan.command.slice(0, chars)}</span>
            {!commandDone && !suppressCaret && (
              // Thin, like the native caret of the real prompt below it: the wide
              // block this used to be duplicated that caret the moment a session
              // started and both jumped around while typing, which read as two
              // inputs. Same width, same accent, same blink on both sides.
              <span aria-hidden="true" className="ml-0.5 inline-block h-4 w-[2px] bg-accent motion-safe:animate-pulse" />
            )}
          </motion.p>
        )}
        {!blank &&
          scan.output.slice(0, lines).map((l, i) => (
            <motion.p
              key={`${scan.command}-${l}`}
              className="truncate text-slate-600 dark:text-neutral-400"
              initial={reduce ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: "spring", stiffness: 100, damping: 20 }}
              exit={{
                opacity: 0,
                y: -6,
                transition: {
                  duration: CLEAR_EXIT_MS,
                  ease: "easeIn",
                  delay: (i + 1) * CLEAR_STAGGER_S,
                },
              }}
            >
              <span className="sr-only">{`output line ${i + 1}: `}</span>
              {l}
            </motion.p>
          ))}
      </AnimatePresence>
      {done && rotating && !suppressCaret && (
        <p className="truncate text-slate-700 dark:text-neutral-300">
          <span className="text-accent">$ </span>
          <AnimatePresence>
            {typingClear && (
              <motion.span
                key="clear-word"
                className="text-slate-900 dark:text-neutral-100"
                exit={{ opacity: 0, transition: { duration: CLEAR_EXIT_MS, ease: "easeIn" } }}
              >
                {CLEAR_CMD.slice(0, clearChars ?? 0)}
              </motion.span>
            )}
          </AnimatePresence>
          {/* Thin, not a block: see the caret on the command line above. The
              attract caret and the live prompt's native caret are the same width
              so the window never looks like it has two different cursors. */}
          <span aria-hidden="true" className="ml-0.5 inline-block h-4 w-[2px] bg-accent motion-safe:animate-pulse" />
        </p>
      )}
    </div>
  );
}
