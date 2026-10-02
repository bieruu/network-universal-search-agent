"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

// Terminal typing effect: the command is typed char-by-char, then output
// lines appear sequentially like a real execution. Between two samples it
// types `clear`, then the screen wipes itself out (staggered fade + slide-up)
// before the next scan, so the rotation reads like one continuous shell
// session instead of an abrupt jump. Static full output when reduced motion
// is on; full text is also SSR'd (see Hero fallback).
const SCANS = [
  {
    command: "scan example.com",
    output: [
      "shodan  passive source · 2 ports seen",
      "crt.sh  3 cert names · issuer letsencrypt",
      "whois   registrar reserved · emails redacted",
      "risk    heuristic match · status partial",
    ],
  },
  {
    command: "scan api.acme.co",
    output: [
      "shodan  passive source · 6 ports seen",
      "crt.sh  12 names found · issuer sectigo",
      "whois   registrar namecheap · ns 3 found",
      "risk    heuristic match · status elevated",
    ],
  },
  {
    command: "scan portal.nova.io",
    output: [
      "shodan  passive source · 8 ports seen",
      "crt.sh  9 names found · issuer digicert",
      "whois   registrar cloudflare · emails masked",
      "risk    heuristic match · status monitored",
    ],
  },
] as const;

const CHAR_MS = 28;
const LINE_PAUSE_MS = 320;
const LOOP_DELAY_MS = 1000; // pause after output before typing `clear`
const CLEAR_CMD = "clear";
const CLEAR_PAUSE_MS = 650; // hold `clear` on screen (the "enter" beat)
const CLEAR_BLANK_MS = 520; // wipe + blank beat before the next sample
const CLEAR_EXIT_MS = 0.22; // per-line clear (wipe) animation duration, seconds
const CLEAR_STAGGER_S = 0.045; // top-to-bottom cascade between cleared lines

export default function TerminalTyper() {
  const reduce = useReducedMotion();
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
    const scan = SCANS[scanIndex];
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
    // 3) Output done → hold, then start typing `clear`.
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
      setScanIndex((index) => (index + 1 === SCANS.length ? 0 : index + 1));
      setChars(0);
      setLines(0);
      setClearChars(null);
    }, CLEAR_BLANK_MS);
    return () => clearTimeout(t);
  }, [mounted, chars, lines, clearChars, reduce, scanIndex]);

  const scan = SCANS[scanIndex];

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
            {!commandDone && (
              <span aria-hidden="true" className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-accent" />
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
      {done && (
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
          <span aria-hidden="true" className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-accent" />
        </p>
      )}
    </div>
  );
}
