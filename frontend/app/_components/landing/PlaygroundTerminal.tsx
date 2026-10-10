"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { motion, useReducedMotion } from "motion/react";
import { fetchHistory, pollScan, startScan } from "@/lib/api";
import { sourceFailureCount } from "@/lib/scan-status";
import { UserFacingError } from "@/lib/user-errors";
import { HELP_LINES, parseCommand } from "@/lib/playground-commands";
import { terminalLinesFromScan, type TerminalSample } from "./terminal-lines";
import TerminalTyper from "./TerminalTyper";
import {
  DEMO_LIST_NOTICE,
  DEMO_NOTICE,
  DEMO_SIGN_IN_HINT,
  DEMO_TARGETS,
  findDemoTarget,
} from "./playground-demo";

/**
 * The hero terminal, now actually a terminal.
 *
 * ATTENTION IS BOUGHT WITH A CLICK, NOT A HOVER
 * --------------------------------------------
 * The window is a demo until it is clicked. Hover was tried and rejected: the
 * pointer passes over a window on its way somewhere else, so merely crossing the
 * hero blanked the output and stole the keyboard. A click is a decision. On that
 * click the terminal wipes itself — animated, never a silent vanish, so the
 * visitor can see what was cleared and does not think it broke — and the prompt
 * is already waiting when the wipe finishes. Clicking anywhere outside hands
 * the window back to the attract loop.
 *
 * THE PROMPT IS NOT A ROW
 * -----------------------
 * The prompt is the last line INSIDE the transcript, styled like every other
 * line, with no border and no separate field. An earlier version rendered a real
 * `<input>` in its own bordered strip below the output, which made the window
 * read as "a terminal" sitting next to "a search box" rather than as one
 * terminal. There is exactly one prompt and it belongs to the transcript.
 *
 * WHY SIGNED-OUT NEVER TOUCHES THE NETWORK
 * -----------------------------------------
 * There is no anonymous scan route; every backend scan endpoint calls
 * `require_user()` (AGENTS.md 5.2), and Shodan is metered by ONE shared paid
 * key (AGENTS.md 5.5). So a signed-out "scan" answers from static fixtures and
 * says so, twice: a notice above the output, and a DEMO caption under the
 * window. A simulated result that could be mistaken for a real one would be the
 * one unacceptable bug in this file.
 *
 * PRIVACY
 * -------
 * The signed-in history is fetched CLIENT-SIDE, inside `list`, and never
 * rendered on the server. `page.tsx` passes only `sample` (already masked by
 * `terminalLinesFromScan`) and `signedIn`, so no unmasked analyst target can
 * reach the server-rendered HTML that a CDN is free to retain. Everything this
 * component prints after the click is client-only for that reason.
 *
 * MOTION
 * ------
 * The clear wipe reuses the exit values `TerminalTyper` already documents
 * (220ms/line, 45ms top-to-bottom cascade) so the two halves of this file wipe
 * identically. Printed output reuses the landing's existing spring (stiffness
 * 100 / damping 20). No new keyframes, no new durations, transform + opacity
 * only. Under reduced motion both the wipe and the line cascade resolve at once.
 */

type EntryKind = "echo" | "line" | "muted" | "notice" | "error";

/**
 * One run of text plus whether it is a description.
 *
 * This exists so `list` and `help` can render the way a terminal does: the
 * command or target in normal weight, its explanation pushed back a step. A
 * single flat string cannot express that, and flattening it was the original
 * complaint — the list looked like prose pasted into a monospace block rather
 * than a terminal answering.
 */
interface Part {
  text: string;
  dim: boolean;
}

interface Entry {
  id: number;
  kind: EntryKind;
  parts: Part[];
  /**
   * Seconds to wait before this line prints. Assigned when the line is created
   * and never recomputed, so a batch of output cascades in the order it was
   * written while lines already on screen keep the timing they were born with.
   */
  delay: number;
}

/** Widest demo target plus breathing room, so the list column stays aligned. */
const LIST_COLUMN = 18;

/** Per-account history rows shown by `list`. Long lists are noise, not context. */
const MAX_HISTORY_ROWS = 10;

const STAGGER_S = 0.1;

/** Tall enough for a scan result, short enough that the hero never reflows. */
const WINDOW_HEIGHT = "h-[14rem]";

/** The clear wipe, matched to `TerminalTyper`'s documented exit values. */
const WIPE_EXIT_S = 0.22;
const WIPE_STAGGER_S = 0.045;

/**
 * The stack this terminal is wired to, as brand marks.
 *
 * Shown small, inside the window, because the terminal IS the product and a
 * visitor who reaches for it has earned a look at what answers it. The marks
 * come from the Simple Icons CDN with the accent as the only colour, which is
 * the pattern DESIGN.md already documents for the logo strip.
 *
 * Why frameworks and not the four data sources: `LogoStrip` deliberately shows
 * the *sources* instead of the frameworks, on the reasoning that a buyer wants
 * to know whose records the answer comes from. That decision stands. The
 * framework marks live here instead of in a logo wall, so the page keeps one
 * provenance strip and the terminal keeps its own identity — a shell that
 * looked up your domain should look like it was built with something.
 *
 * `shodan` and the other source marks are NOT here: they have no Simple Icons
 * slug (Shodan 404s on the CDN — a recorded deviation), and DESIGN.md's rule is
 * mono monograms for marks without an icon, not a half-set of icons next to
 * half a set of monograms.
 */
const STACK_MARKS: Array<{ slug: string; name: string }> = [
  { slug: "next.js", name: "Next.js" },
  { slug: "fastapi", name: "FastAPI" },
  { slug: "postgresql", name: "PostgreSQL" },
  { slug: "typescript", name: "TypeScript" },
  { slug: "tailwindcss", name: "Tailwind CSS" },
];

export interface PlaygroundTerminalProps {
  signedIn: boolean;
  sample?: TerminalSample | null;
}

export default function PlaygroundTerminal({
  signedIn,
  sample = null,
}: PlaygroundTerminalProps) {
  const reduce = useReducedMotion();
  // True once the window has been clicked; released when the prompt loses focus,
  // which is what a click anywhere else does.
  const [session, setSession] = useState(false);
  // "in" = the click that opens a session, "out" = the one that closes it.
  // Which one matters: on the way in the prompt must NOT wipe out along with
  // the text it is replacing.
  const [wipeDir, setWipeDir] = useState<"in" | "out" | null>(null);
  // What the attract loop is showing right now. Without this the first click
  // had nothing to animate away and the window just went blank.
  const [attractLines, setAttractLines] = useState<string[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  // `listed` is the discovery step the whole terminal is built around: `scan`
  // is refused until the visitor has run `list`. See lib/playground-commands.ts.
  const [listed, setListed] = useState(false);
  // Shell-style recall. `historyIdx` is null whenever the visitor is editing
  // rather than scrolling, so arrow keys resume from the newest entry instead
  // of jumping into the middle of the list.
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState<number | null>(null);

  const nextId = useRef(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Set when the wipe in progress is the one that hands the window back to the
  // attract loop, as opposed to the one that opens a session.
  const wipeDirRef = useRef<"in" | "out" | null>(null);
  // The prompt cannot be focused while it is disabled, and disabling it is what
  // makes the visitor wait out the clear. So the intent to hold focus is parked
  // here and replayed once the wipe ends.
  const wantFocus = useRef(false);
  const wiping = wipeDir !== null;

  // The id is captured into a local BEFORE setEntries. Reading `nextId.current`
  // inside the updater looks equivalent and is not: the updater runs later, by
  // which time two calls have already advanced the counter, and React then gets
  // handed the same key twice — which silently duplicates and omits rows instead
  // of throwing.
  const push = useCallback((kind: EntryKind, text: string) => {
    const id = (nextId.current += 1);
    setEntries((prev) => [...prev, { id, kind, parts: [{ text, dim: false }], delay: 0 }]);
  }, []);

  // One entry PER LINE, staggered, so a four-line scan result prints as four
  // rows. An earlier version routed it through a helper that built ONE entry
  // from the whole array, which ran all four together into a single unreadable
  // row — the stagger only exists per entry, so lines must be separate entries.
  const pushLines = useCallback((kind: EntryKind, lines: readonly string[]) => {
    const batch = lines.map((text, i) => ({
      id: nextId.current + 1 + i,
      kind,
      parts: [{ text, dim: false }],
      delay: i * STAGGER_S,
    }));
    nextId.current += lines.length;
    setEntries((prev) => [...prev, ...batch]);
  }, []);

  const pushRows = useCallback(
    (kind: EntryKind, rows: Array<{ lead: string; rest: string }>) => {
      const batch = rows.map((row, i) => ({
        id: nextId.current + 1 + i,
        kind,
        parts: [
          { text: row.lead, dim: false },
          { text: row.rest, dim: true },
        ],
        delay: i * STAGGER_S,
      }));
      nextId.current += rows.length;
      setEntries((prev) => [...prev, ...batch]);
    },
    [],
  );

  // Keep the newest line in view. Done through a ref rather than a scroll
  // listener on purpose: the landing forbids manual scroll listeners (DESIGN.md
  // Motion) and this only needs to react to the transcript growing.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, busy]);

  /**
   * Ends a wipe: drop the transcript, then either open the session (prompt
   * focused and waiting) or hand the window back to the attract loop.
   *
   * The transcript is emptied HERE, after the exit animation has played, never
   * at the moment the click landed. Removing it immediately is what makes a
   * terminal look broken — the output vanishes with nothing explaining why.
   */
  const finishWipe = useCallback(() => {
    setEntries([]);
    const dir = wipeDirRef.current;
    wipeDirRef.current = null;
    setWipeDir(null);
    if (dir === "out") {
      wantFocus.current = false;
      setSession(false);
      setInput("");
    }
  }, []);

  // Both edges run a clear, so the window is seen to wipe itself on the way in
  // AND on the way out. Leaving without a wipe used to snap the output away and
  // drop the attract loop in its place, which read as a glitch rather than as
  // the terminal tidying up after itself.
  useEffect(() => {
    if (!wiping) return;
    const ms = reduce ? 0 : (WIPE_EXIT_S + WIPE_STAGGER_S * entries.length + 0.06) * 1000;
    const t = setTimeout(finishWipe, ms);
    return () => clearTimeout(t);
  }, [wiping, entries.length, reduce, finishWipe]);

  const startWipe = useCallback((dir: "in" | "out") => {
    wipeDirRef.current = dir;
    setWipeDir(dir);
  }, []);

  // Focus the prompt as soon as it is enabled again. This is the "wait for the
  // clear, then type" half of the behaviour: during the wipe the field is
  // disabled, so keystrokes are dropped instead of racing the animation.
  useEffect(() => {
    if (!session || wiping || busy) return;
    if (!wantFocus.current) return;
    wantFocus.current = false;
    inputRef.current?.focus();
  }, [session, wiping, busy]);

  const onAttractSnapshot = useCallback((lines: string[]) => {
    setAttractLines(lines);
  }, []);

  const takeOver = useCallback(() => {
    setSession(true);
    wantFocus.current = true;
    // Seed the transcript with exactly what the attract loop is showing, so the
    // clear animates away the text the visitor was actually looking at instead
    // of blanking the window. This is what a shell does: `clear` scrolls the
    // old output away, it does not cut to black.
    const seed = attractLines.filter((line) => line.length > 0);
    if (seed.length) {
      const base = nextId.current;
      nextId.current += seed.length;
      setEntries(
        seed.map((text, i) => ({
          id: base + i + 1,
          kind: "line" as const,
          parts: [{ text, dim: false }],
          delay: i * STAGGER_S,
        })),
      );
    }
    startWipe("in");
  }, [attractLines, startWipe]);

  /** Leaving is deliberately a wipe, not a reset. */
  const release = useCallback(() => {
    if (wipeDirRef.current === "out") return;
    startWipe("out");
  }, [startWipe]);

  /**
   * Splits `help` lines into their command column and their explanation.
   *
   * The separator is the first run of two or more spaces, which is what
   * `HELP_LINES` is typeset with. A line without one (the intro sentence, the
   * list-before-scan reminder) is prose, and prose is returned whole rather
   * than split on a space that means nothing.
   */
  const splitCommandLine = useCallback((line: string): { lead: string; rest: string } => {
    const m = line.match(/^(\s*\S+(?:\s\S+)*?)(\s{2,})(\S.*)$/);
    return m ? { lead: m[1], rest: m[2] + m[3] } : { lead: line, rest: "" };
  }, []);

  const runDemoScan = useCallback(
    (target: string) => {
      const demo = findDemoTarget(target);
      if (!demo) {
        push("error", `${target} is not in the demo list.`);
        push("muted", DEMO_SIGN_IN_HINT);
        return;
      }
      // The notice is a separate line, above the output, not a prefix on it.
      push("notice", DEMO_NOTICE);
      pushLines("line", demo.output);
    },
    [push, pushLines],
  );

  const runLiveScan = useCallback(
    async (target: string) => {
      push("muted", "reading public sources — shodan, crt.sh, whois");
      try {
        const started = await startScan(target);
        const result = await pollScan(started.scan_id, { timeoutMs: 60000 });
        const rendered = terminalLinesFromScan(result);
        if (rendered) {
          pushLines("line", rendered.output);
        } else {
          push("line", "nothing was returned for this target.");
        }
        const failures = sourceFailureCount(result.errors.length);
        if (failures) push("muted", failures);
      } catch (e) {
        if (e instanceof UserFacingError) {
          push("error", e.message);
          // A 401 here means the session lapsed between page load and click.
          // The demo hint is the most useful next step, so it is the one shown.
          if (e.status === 401) push("muted", DEMO_SIGN_IN_HINT);
          return;
        }
        push("error", "The search service did not respond.");
      }
    },
    [push, pushLines],
  );

  const runList = useCallback(async () => {
    push("muted", signedIn ? "your targets" : "3 demo targets");
    if (signedIn) {
      // Fetched here, not rendered on the server: see PRIVACY above.
      let rows: string[] = [];
      try {
        const history = await fetchHistory();
        rows = history.items
          .map((item) => item.target)
          .filter((t): t is string => typeof t === "string" && t.length > 0)
          .slice(0, MAX_HISTORY_ROWS);
      } catch {
        push("muted", "your history could not be loaded — any domain still works.");
      }
      const unique = Array.from(new Set(rows));
      if (unique.length) {
        pushRows(
          "line",
          unique.map((t) => ({ lead: t.padEnd(LIST_COLUMN), rest: "your last scan" })),
        );
      } else {
        push("muted", "no scans recorded yet — any domain or public IP works.");
      }
      push(
        "muted",
        DEMO_TARGETS.map((t) => t.target).join(", ") + " also work, scanned live",
      );
    } else {
      pushRows(
        "line",
        DEMO_TARGETS.map((t) => ({ lead: t.target.padEnd(LIST_COLUMN), rest: t.blurb })),
      );
      push("muted", DEMO_LIST_NOTICE);
    }
  }, [signedIn, push, pushRows]);

  const submit = useCallback(async () => {
    const parsed = parseCommand(input, { listed });
    const typed = input.trim();
    setInput("");
    setHistoryIdx(null);
    if (!parsed.command && !parsed.error) return;

    // Shell recall history: only non-empty lines, never a duplicate of the one
    // before it, so holding the up arrow does not replay the same command.
    if (typed && history[history.length - 1] !== typed) {
      setHistory((prev) => [...prev, typed]);
    }

    // Echo first, always: the transcript records what was typed, even when the
    // command was refused, which is what makes the refusal legible.
    push("echo", parsed.echo);
    if (parsed.error) {
      push("error", parsed.error);
      return;
    }

    if (parsed.command === "clear") {
      // The typed `clear` runs the SAME wipe the two edges of a session run, so
      // the command is answered with a visible wipe rather than a silent vanish:
      // emptying the transcript here left the click-in / click-out clears of the
      // same window as the only animated ones, and an instant blank read as the
      // terminal breaking instead of as a shell tidying up. The echo line has
      // already printed above, so the visitor sees what caused it.
      //
      // "in", not "out": `finishWipe` only hands the window back to the attract
      // loop when it sees "out", so "in" keeps `session === true` and leaves the
      // prompt where it was — just focused, and the transcript empty. Nothing is
      // duplicated: the existing wipe effect owns the timing and `finishWipe`
      // still empties `entries` once the exit has played.
      //
      // The field is disabled while the wipe plays, and a disabled field does
      // not hold focus, so the intent to come back to it is parked for the
      // existing focus effect to replay when the wipe ends.
      wantFocus.current = true;
      startWipe("in");
      return;
    }
    if (parsed.command === "help") {
      pushRows(
        "line",
        HELP_LINES.map((line) => splitCommandLine(line)).filter((r) => r.rest !== ""),
      );
      return;
    }
    if (parsed.command === "list") {
      setListed(true);
      await runList();
      return;
    }
    if (parsed.command === "scan" && parsed.target) {
      setBusy(true);
      try {
        if (signedIn) await runLiveScan(parsed.target);
        else runDemoScan(parsed.target);
      } finally {
        setBusy(false);
      }
    }
  }, [input, listed, signedIn, history, push, pushRows, splitCommandLine, runList, runDemoScan, runLiveScan, startWipe]);

  /**
   * Shell-style history recall on the arrow keys.
   *
   * Up walks BACK from the newest entry and down walks forward to an empty
   * prompt. The direction of travel is the whole point: pressing up once must
   * land on what you ran last, not on the oldest thing in the list. An earlier
   * version applied its starting offset and then the step as well, which started
   * up at index 0 and made the list read oldest-first.
   *
   * `historyIdx === null` means the visitor was editing rather than scrolling.
   * Up then enters at the newest entry; down has nothing ahead to walk to, so it
   * just returns the empty prompt to where typing left it.
   */
  const recall = useCallback(
    (dir: -1 | 1) => {
      if (!history.length) return;
      let idx: number;
      if (historyIdx === null) {
        if (dir === 1) {
          setInput("");
          return;
        }
        idx = history.length - 1;
      } else {
        idx = historyIdx + dir;
      }
      if (idx >= history.length) {
        setHistoryIdx(null);
        setInput("");
        return;
      }
      if (idx < 0) idx = 0;
      setHistoryIdx(idx);
      setInput(history[idx]);
      // Put the caret at the end, where a shell leaves it after recall.
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (el) el.setSelectionRange(el.value.length, el.value.length);
      });
    },
    [history, historyIdx],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        recall(-1);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        recall(1);
      }
    },
    [recall],
  );

  const mode = signedIn ? "live" : "demo";

  // One line, three states. The demo state never stops saying "simulated" for
  // as long as the terminal is showing simulated output.
  const caption = !session
    ? sample
      ? "Your last search"
      : "Sample output — click the terminal to try it"
    : mode === "demo"
      ? "Demo — simulated output for three fixed targets"
      : "Live — your scans run against the real API";

  return (
    <div
      className="space-y-2"
      // Taking over swallows the click so the browser does not move focus to
      // the clicked line and immediately blur the prompt we just focused.
      // Inside a live session the default is left alone, so the visitor can
      // still select and copy the output.
      onMouseDown={(e) => {
        if (session) return;
        e.preventDefault();
        takeOver();
      }}
    >
      <div
        ref={scrollRef}
        className={`terminal-scroll flex ${WINDOW_HEIGHT} flex-col overflow-y-auto font-mono text-[13px] leading-relaxed sm:text-sm`}
      >
        {session ? (
          <div className="mt-auto space-y-1">
            {entries.map((entry, i) => (
              <motion.p
                key={entry.id}
                // On the way in the seeded lines are ALREADY on screen, so they
                // must appear at rest and then leave — giving them the entrance
                // `initial` would play a fade-in of text that is mid-fade-out.
                initial={
                  reduce
                    ? false
                    : wipeDir === "in"
                      ? { opacity: 1, y: 0 }
                      : { opacity: 0, y: 8 }
                }
                animate={wiping ? { opacity: 0, y: -6 } : { opacity: 1, y: 0 }}
                transition={
                  reduce
                    ? { duration: 0 }
                    : wiping
                      ? {
                          duration: WIPE_EXIT_S,
                          ease: "easeIn",
                          delay: i * WIPE_STAGGER_S,
                        }
                      : { type: "spring", stiffness: 100, damping: 20, delay: entry.delay }
                }
                className="truncate"
              >
                {entry.kind === "echo" && <span className="text-accent">$ </span>}
                {entry.parts.map((part, j) => (
                  <span
                    key={j}
                    className={
                      part.dim
                        ? "text-slate-500 dark:text-neutral-500"
                        : entry.kind === "echo"
                          ? "text-slate-900 dark:text-neutral-100"
                          : entry.kind === "error"
                            ? "text-accent"
                            : entry.kind === "notice" || entry.kind === "muted"
                              ? "text-slate-500 dark:text-neutral-500"
                              : "text-slate-700 dark:text-neutral-300"
                    }
                  >
                    {part.text}
                  </span>
                ))}
              </motion.p>
            ))}
            {/* The prompt is the last line of the transcript, not a separate
                field under it — one terminal, one prompt, nothing between. It
                wipes out with the rest of the output on the way OUT only; on the
                way in it must appear while the text above it is leaving, which is
                what makes the click read as `clear` followed by a live prompt. It
                is disabled while the clear plays so nobody can type into a screen
                that is mid-wipe. */}
            <motion.div
              initial={reduce ? false : { opacity: 0, y: 8 }}
              animate={wipeDir === "out" ? { opacity: 0, y: -6 } : { opacity: 1, y: 0 }}
              transition={
                reduce
                  ? { duration: 0 }
                  : wipeDir === "out"
                    ? { duration: WIPE_EXIT_S, ease: "easeIn" }
                    : { type: "spring", stiffness: 100, damping: 20 }
              }
              className="flex items-center gap-2"
            >
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit();
                }}
                className="flex w-full items-center gap-2"
              >
                <label htmlFor="playground-prompt" className="sr-only">
                  Search command. Use the up arrow for commands you ran before.
                </label>
                <span aria-hidden="true" className="text-accent">
                  $
                </span>
                <input
                  id="playground-prompt"
                  ref={inputRef}
                  value={input}
                  onChange={(e) => {
                    setHistoryIdx(null);
                    setInput(e.target.value);
                  }}
                  onKeyDown={onKeyDown}
                  onBlur={release}
                  disabled={busy || wiping}
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  maxLength={253}
                  placeholder={busy ? "searching…" : "type list, then scan <domain>"}
                  // `caret-accent` recolours the NATIVE caret rather than
                  // painting a block beside it. A painted block duplicated the
                  // caret and both jumped around while typing.
                  className="h-5 min-w-0 flex-1 bg-transparent font-mono text-[13px] text-slate-900 caret-accent outline-none placeholder:text-slate-400 disabled:cursor-progress sm:text-sm dark:text-neutral-100 dark:placeholder:text-neutral-500"
                />
              </form>
            </motion.div>
          </div>
        ) : (
          <div className="mt-auto">
            {/* The attract loop keeps its own blinking caret AND its own typed
                `clear`, because while nobody is in a session there is no real
                prompt for either to collide with — the green block is the whole
                point of the demo, and hiding it left a dead-looking window.
                It is suppressed the moment a session starts, because then the
                real prompt below IS the cursor and two blocks would read as two
                inputs again. */}
            <TerminalTyper sample={sample} suppressCaret={session} onSnapshot={onAttractSnapshot} />
          </div>
        )}
      </div>

      {/* The stack the terminal is wired to, small enough to read as part of the
          window rather than as a logo wall. `motion-safe:` gates the bob, the
          accent is the only colour, and the marks come from the Simple Icons
          CDN DESIGN.md already documents. Each carries its name in the `title`
          and in `aria-label`, because an icon with no name is decoration. */}
        <div
          className="flex items-center gap-3 px-3 pt-2"
          aria-label="Built with"
        >
          {STACK_MARKS.map((mark, i) => (
            <img
              key={mark.slug}
              src={`https://cdn.simpleicons.org/${mark.slug}/00E59B`}
              alt={mark.name}
              title={mark.name}
              width={14}
              height={14}
              loading="lazy"
              decoding="async"
              className="opacity-70 transition-opacity duration-200 hover:opacity-100 motion-safe:animate-bob dark:opacity-80"
              style={{ animationDelay: `${i * 0.5}s` }}
            />
          ))}
        </div>

      {/* Status line, the way a shell carries one. Signed out it must say so
          plainly and permanently: the alternative is a visitor reading
          simulated output as the product's real answer, which is the one thing
          this file must not allow. */}
      <p className="text-right font-mono text-xs text-slate-500 dark:text-neutral-500">
        {caption}
      </p>
    </div>
  );
}