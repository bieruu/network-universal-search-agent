/**
 * The grammar behind the landing page's interactive playground terminal.
 *
 * WHAT THE GRAMMAR IS. Four keywords and nothing else:
 *
 *     help            print the command list
 *     list            print the targets this playground can scan
 *     scan <domain>   scan a target
 *     clear           wipe the transcript
 *
 * A bare domain with no keyword (`wikipedia.org`, `8.8.8.8`) is shorthand for
 * `scan <domain>`. Only the FIRST whitespace-separated token is ever tested
 * against a keyword, and a domain can never be one of them because every
 * domain carries a dot. That is why a bare domain falls through to shorthand
 * instead of being reported as an unknown command.
 *
 * WHY IT IS PURE AND IN ITS OWN FILE. This module does no I/O, calls no
 * React, and knows nothing about auth or the network. It turns a keystroke
 * into a decision and a sentence. Keeping it pure is what makes the terminal
 * testable: the rules below are asserted directly in
 * `lib/playground-commands.test.ts` with no browser, no fetch mocking, and no
 * timing. The component that owns the transcript decides what to do with the
 * result; this file only decides what was meant.
 *
 * WHY THE `list` GATE EXISTS. Signed out, this playground only ever scans
 * three fixed demo targets and prints clearly-labelled SIMULATED output. The
 * gate makes the visitor run `list` first, which is the whole point of the
 * terminal: in a real shell you discover what a box can do before you ask it
 * to do something, and `list` is that discovery step. It also keeps the
 * signed-out path honest — the targets are shown as a known, fixed set rather
 * than as anything the visitor can aim at an arbitrary host. A visitor who
 * skips straight to `scan` is told what to do instead of being refused with a
 * dead end.
 *
 * The gate clears the TARGET on rejection, not just on error. A half-typed
 * domain from a gated attempt must not survive into a later request: the
 * caller is expected to be able to trust that a non-null `target` means this
 * very keystroke asked for it.
 *
 * ERROR STYLE. Errors are plain user-facing English, returned in `error` —
 * never thrown. A terminal does not stack traces. Every message here is copy a
 * signed-out visitor is expected to read and understand, and `echo` is always
 * returned untouched so the transcript shows what was actually typed rather
 * than what we thought was meant.
 */

/** Longest unknown input echoed back inside an error message. */
const UNKNOWN_ECHO_LIMIT = 40;

export type PlaygroundCommand = "help" | "list" | "scan" | "clear";

export interface ParsedCommand {
  /** The resolved command, or null for empty input and unrecognised input. */
  command: PlaygroundCommand | null;
  /** The scan target, or "" when there is none or it was refused by the gate. */
  target: string;
  /** Plain text to print, or null when the input was understood. */
  error: string | null;
  /** The trimmed input exactly as typed. Never normalised for display. */
  echo: string;
}

/**
 * The `help` output. Line order matches the order the commands are meant to be
 * discovered in, and the list-before-scan rule is stated in the line where the
 * reader needs it — next to `scan`, not in a footnote at the bottom.
 *
 * No `%` anywhere: these lines are rendered as plain text, and a stray
 * percent sign reads as a broken format spec to anyone reading them raw.
 */
export const HELP_LINES: readonly string[] = [
  "A small terminal over this product's scan API. Four commands.",
  "  help            show this list",
  "  list            show the targets this playground can scan",
  "  scan <domain>   scan a target and print a summary",
  "  clear           wipe the transcript",
  "Run list before scan. Signed out, the targets are three fixed",
  "demo hosts and their output is SIMULATED, not a live scan.",
  "Signed in, scan queries the real API for any domain or public IP.",
  "Typing a bare domain, for example wikipedia.org, is shorthand for scan.",
];

/**
 * Resolves one keystroke into a command.
 *
 * `listed` reports whether the visitor has already run `list` in this
 * session. It is passed in rather than tracked here so the module stays a pure
 * function of its arguments and the gate can never be bypassed by mutating
 * module state.
 */
export function parseCommand(raw: string, ctx: { listed: boolean }): ParsedCommand {
  const echo = typeof raw === "string" ? raw.trim() : "";

  // An empty keystroke (Enter on a blank prompt) is not an error. It must not
  // print anything or it would push a stray empty line into the transcript.
  if (!echo) return { command: null, target: "", error: null, echo: "" };

  const firstSpace = echo.search(/\s/);
  const keyword = (firstSpace === -1 ? echo : echo.slice(0, firstSpace)).toLowerCase();
  const rest = firstSpace === -1 ? "" : echo.slice(firstSpace + 1).trim();

  if (keyword === "help") return { command: "help", target: "", error: null, echo };
  if (keyword === "list") return { command: "list", target: "", error: null, echo };
  if (keyword === "clear") return { command: "clear", target: "", error: null, echo };

  // `scan`, and the bare-domain shorthand, share one gate check below.
  if (keyword === "scan") return resolveScan(rest, ctx, echo);

  // A bare domain: no keyword, but it looks like something scannable, so it is
  // shorthand rather than a typo. The gate applies to it exactly as it does to
  // an explicit `scan`.
  if (looksLikeTarget(echo)) return resolveScan(echo, ctx, echo);

  const shown = echo.length > UNKNOWN_ECHO_LIMIT ? echo.slice(0, UNKNOWN_ECHO_LIMIT) : echo;
  return {
    command: null,
    target: "",
    error: `Unknown command: "${shown}". Type help to see what this terminal accepts.`,
    echo,
  };
}

/**
 * Shared tail of the `scan` path: usage check first, then the gate.
 *
 * The order matters. An argumentless `scan` reports the usage message even
 * while ungated, because there is no target to gate and "you forgot the
 * argument" is the more useful thing to tell someone.
 */
function resolveScan(target: string, ctx: { listed: boolean }, echo: string): ParsedCommand {
  if (!target) return { command: "scan", target: "", error: "usage: scan <domain>", echo };

  if (!ctx.listed) {
    // Target deliberately dropped: a refused attempt must leave nothing behind.
    return {
      command: "scan",
      target: "",
      error: "Run list first — it shows what this playground can scan.",
      echo,
    };
  }

  return { command: "scan", target, error: null, echo };
}

/**
 * Cheap shape test for the bare-domain shorthand: something that carries a
 * dot and has no spaces. Deliberately permissive — this only decides whether
 * to treat the line as a target, never whether the target is acceptable. Real
 * validation still belongs to the scan layer.
 */
function looksLikeTarget(input: string): boolean {
  return input.includes(".") && !/\s/.test(input);
}