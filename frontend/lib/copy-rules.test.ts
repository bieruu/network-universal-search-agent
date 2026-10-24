import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCES } from "../app/_components/landing/source-copy.ts";

/**
 * COPY RULES (DESIGN.md "Copy").
 *
 * Two things are checked here that no other test can:
 *
 * 1. The em dash is banned from every source file, not just from the copy that
 *    happens to be pinned elsewhere. DESIGN.md asks for plain hyphens; a sweep
 *    that only fixes the strings a test names leaves the next one free to
 *    reintroduce it. Built from a char code on purpose - a literal in this file
 *    would fail its own walk.
 * 2. The shared source copy obeys its numeric limits. `gives` renders on the
 *    logo strip's answer panel and `result` / `outcome` render in the
 *    how-it-works rows, so a rewrite that grows past the limit is a layout bug
 *    in the surface that shows it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const EM_DASH = String.fromCharCode(0x2014);

const WALKED = ["app", "components", "lib", "scripts"];
const EXTENSIONS = [".ts", ".tsx", ".css", ".mjs", ".js"];
const SKIP_DIRS = new Set(["node_modules", ".next", "out", "coverage"]);
const GENERATED = new Set(["next-env.d.ts"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (EXTENSIONS.some((ext) => entry.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Root config files (middleware, next.config, postcss, .env.local.example) sit
 * outside WALKED, so the rule covered `frontend/` everywhere except the files
 * that boot it. Generated output is skipped, not checked.
 */
function rootFiles(): string[] {
  return readdirSync(root)
    .filter((entry) => !GENERATED.has(entry) && statSync(join(root, entry)).isFile())
    .filter((entry) => EXTENSIONS.some((ext) => entry.endsWith(ext)) || /^\.env.*\.example$/.test(entry))
    .map((entry) => join(root, entry));
}

/** Whitespace-separated tokens, which is the unit the design limit names. */
function words(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Terminators followed by space or end, never the dots inside a version. */
function sentences(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return (trimmed.match(/[.!?](?=\s|$)/g) ?? []).length || 1;
}

test("no em dash survives anywhere under frontend/", () => {
  const offenders: string[] = [];
  const files = [...rootFiles(), ...WALKED.flatMap((dir) => walk(join(root, dir)))];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    if (!text.includes(EM_DASH)) continue;
    const lines = text
      .split("\n")
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => line.includes(EM_DASH))
      .map(({ n }) => n);
    offenders.push(`${relative(root, file)}:${lines.join(",")}`);
  }
  assert.deepEqual(
    offenders,
    [],
    `em dash (U+2014) found - use " - ". ${offenders.join(" | ")}`,
  );
});

test("shared source copy stays inside its word and sentence limits", () => {
  assert.equal(SOURCES.length, 4, "one entry per data source");
  for (const s of SOURCES) {
    assert.ok(s.mark.trim().length > 0, "a source row needs its mark");
    assert.ok(
      words(s.detail) <= 18 && sentences(s.detail) <= 1,
      `${s.mark}.detail: <= 18 words, one sentence (got ${words(s.detail)} words)`,
    );
    assert.ok(
      words(s.result) <= 4,
      `${s.mark}.result: <= 4 words, it is a row label (got ${words(s.result)})`,
    );
    assert.ok(
      words(s.outcome) <= 12 && sentences(s.outcome) <= 1,
      `${s.mark}.outcome: <= 12 words, one sentence (got ${words(s.outcome)} words)`,
    );
    assert.ok(
      words(s.gives) <= 12 && sentences(s.gives) <= 1,
      `${s.mark}.gives: <= 12 words, one sentence (got ${words(s.gives)} words)`,
    );
  }
});

/**
 * What each source contributes is now the WHOLE of the strip's answer panel.
 *
 * Two drifts this guards against, both of them real: the copy module once
 * carried a second failure field (its name is assembled below rather than typed
 * out, because the repo is grepped for that dead identifier and a literal here
 * would put a match back into the tree), and the panel once printed it under
 * the contribution line. Removing the field without a test leaves the 'a source
 * did not answer' paragraph free to reappear as a second `<p>` in the panel,
 * which would quietly restore a disclosure the operator removed. So: no such
 * key in the data, and exactly one rendered copy expression - `active.gives`.
 */
test("the source panel shows one line per source and carries no removed field", () => {
  const sourceCopyText = readFileSync(
    join(root, "app", "_components", "landing", "source-copy.ts"),
    "utf8",
  );
  const removedField = "when" + "Slow";
  assert.ok(
    !sourceCopyText.includes(removedField),
    "source-copy.ts must not declare the removed failure field again",
  );
  const stripText = readFileSync(
    join(root, "app", "_components", "landing", "LogoStrip.tsx"),
    "utf8",
  );
  assert.deepEqual(
    stripText.match(/\{active\.\w+\}/g) ?? [],
    ["{active.gives}"],
    "the panel renders exactly one paragraph of source copy: active.gives",
  );
  // A hand-written failure paragraph would pass the `active.*` check above, so
  // the panel is pinned by shape too: exactly one `<p>` may exist in this
  // component, and it is the panel's single muted line.
  assert.equal(
    (stripText.match(/<p\b/g) ?? []).length,
    1,
    "the panel renders exactly one <p>; a second paragraph would restore the removed disclosure",
  );
  // The removed prose (an if-slow line, and one saying the card could not
  // complete the check) could also come back as a literal. The needles are
  // assembled from fragments instead of typed whole, the same way `whenSlow`
  // above is, so the repo-wide grep for the dead field does not match this
  // guard's own source. Only phrasing that means "the source did not answer"
  // is listed: "slow" alone is an ordinary word, not a disclosure.
  const removedPhrases = [
    "slow or " + "unreachable",
    "was " + "unreachable",
    "could not " + "check",
    "could not be " + "read",
    "does not " + "answer",
  ];
  for (const phrase of removedPhrases) {
    assert.ok(
      !stripText.includes(phrase),
      `LogoStrip.tsx must not carry failure copy as a literal ("${phrase}")`,
    );
  }
});
