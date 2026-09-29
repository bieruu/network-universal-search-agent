"use client";

import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";

// Terminal typing effect: the command is typed char-by-char, then output
// lines appear sequentially like a real execution. Static full output when
// reduced motion is on; full text is also SSR'd (see Hero fallback).
const COMMAND = "scan example.com";
const OUTPUT = [
  "shodan  93.184.216.34 · 2 ports · 0 vulns",
  "crt.sh  3 subdomains · issuer Lets Encrypt",
  "whois   registrar RESERVED · emails redacted",
  "risk    18/100 (heuristic v1) · status partial",
] as const;

const CHAR_MS = 28;
const LINE_PAUSE_MS = 320;

export default function TerminalTyper() {
  const reduce = useReducedMotion();
  const [mounted, setMounted] = useState(false);
  const [chars, setChars] = useState(0);
  const [lines, setLines] = useState(0);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    if (reduce) {
      setChars(COMMAND.length);
      setLines(OUTPUT.length);
      return;
    }
    if (chars < COMMAND.length) {
      const t = setTimeout(() => setChars((c) => c + 1), CHAR_MS);
      return () => clearTimeout(t);
    }
    if (lines < OUTPUT.length) {
      const t = setTimeout(() => setLines((l) => l + 1), LINE_PAUSE_MS);
      return () => clearTimeout(t);
    }
  }, [mounted, chars, lines, reduce]);

  // SSR + first paint + no-JS: full static text (SEO/accessible baseline).
  // After mount, the typing performance takes over from zero.
  if (!mounted) {
    return (
      <div className="space-y-1.5">
        <p className="truncate">
          <span className="text-[#00E59B]">$ </span>
          <span className="text-neutral-100">{COMMAND}</span>
        </p>
        {OUTPUT.map((l) => (
          <p key={l} className="truncate text-neutral-400">
            {l}
          </p>
        ))}
      </div>
    );
  }

  const done = chars >= COMMAND.length && lines >= OUTPUT.length;

  return (
    <div aria-live="polite" className="space-y-1.5">
      <p className="truncate">
        <span className="text-[#00E59B]">$ </span>
        <span className="text-neutral-100">{COMMAND.slice(0, chars)}</span>
        {!done && (
          <span aria-hidden="true" className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-[#00E59B]" />
        )}
      </p>
      {OUTPUT.slice(0, lines).map((l, i) => (
        <motion.p
          key={l}
          className="truncate text-neutral-400"
          initial={reduce ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 100, damping: 20 }}
        >
          <span className="sr-only">{`output line ${i + 1}: `}</span>
          {l}
        </motion.p>
      ))}
      {done && (
        <p className="text-neutral-300">
          <span className="text-[#00E59B]">$ </span>
          <span aria-hidden="true" className="inline-block h-4 w-2 animate-pulse bg-[#00E59B]" />
        </p>
      )}
    </div>
  );
}
