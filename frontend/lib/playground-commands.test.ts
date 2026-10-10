import test from "node:test";
import assert from "node:assert/strict";
import { parseCommand, HELP_LINES } from "./playground-commands.ts";

const GATE_ERROR = "Run list first — it shows what this playground can scan.";
const USAGE_ERROR = "usage: scan <domain>";

test("empty input is ignored, not an error", () => {
  for (const blank of ["", "   ", "\t", "\n", "  \t  "]) {
    assert.deepEqual(parseCommand(blank, { listed: false }), {
      command: null,
      target: "",
      error: null,
      echo: "",
    });
  }
});

test("help, list and clear parse with no target", () => {
  for (const cmd of ["help", "list", "clear"] as const) {
    for (const raw of [cmd, `  ${cmd}  `, cmd.toUpperCase()]) {
      const r = parseCommand(raw, { listed: true });
      assert.equal(r.command, cmd, raw);
      assert.equal(r.target, "", raw);
      assert.equal(r.error, null, raw);
    }
  }
});

test("keyword matching is case-insensitive", () => {
  assert.equal(parseCommand("LIST", { listed: false }).command, "list");
  assert.equal(parseCommand("Help", { listed: false }).command, "help");
  assert.equal(parseCommand("ClEaR", { listed: false }).command, "clear");
  assert.equal(parseCommand("SCAN foo.com", { listed: true }).command, "scan");
});

test("scan takes its target from the rest of the line", () => {
  const r = parseCommand("scan wikipedia.org", { listed: true });
  assert.equal(r.command, "scan");
  assert.equal(r.target, "wikipedia.org");
  assert.equal(r.error, null);
});

test("scan tolerates extra internal and trailing whitespace", () => {
  for (const raw of ["scan   wikipedia.org", "scan wikipedia.org   ", "  scan \t wikipedia.org \t "]) {
    const r = parseCommand(raw, { listed: true });
    assert.equal(r.command, "scan", raw);
    assert.equal(r.target, "wikipedia.org", raw);
    assert.equal(r.error, null, raw);
  }
});

test("scan with an IP target works too", () => {
  assert.equal(parseCommand("scan 8.8.8.8", { listed: true }).target, "8.8.8.8");
});

test("argumentless scan reports usage, listed or not", () => {
  for (const raw of ["scan", "scan   "]) {
    const r = parseCommand(raw, { listed: true });
    assert.equal(r.command, "scan", raw);
    assert.equal(r.target, "", raw);
    assert.equal(r.error, USAGE_ERROR, raw);
  }
});

test("the list gate refuses scan and drops the target", () => {
  const r = parseCommand("scan foo.com", { listed: false });
  assert.equal(r.command, "scan");
  assert.equal(r.target, "", "a gated attempt must not leave the target behind");
  assert.equal(r.error, GATE_ERROR);
});

test("the same scan succeeds once list has been run", () => {
  const r = parseCommand("scan foo.com", { listed: true });
  assert.equal(r.command, "scan");
  assert.equal(r.target, "foo.com");
  assert.equal(r.error, null);
});

test("the gate also covers the bare-domain shorthand", () => {
  for (const raw of ["wikipedia.org", "8.8.8.8"]) {
    const gated = parseCommand(raw, { listed: false });
    assert.equal(gated.command, "scan", raw);
    assert.equal(gated.target, "", raw);
    assert.equal(gated.error, GATE_ERROR, raw);

    const allowed = parseCommand(raw, { listed: true });
    assert.equal(allowed.command, "scan", raw);
    assert.equal(allowed.target, raw, raw);
    assert.equal(allowed.error, null, raw);
  }
});

test("argumentless scan while ungated reports usage, not the gate", () => {
  const r = parseCommand("scan", { listed: false });
  assert.equal(r.command, "scan");
  assert.equal(r.error, USAGE_ERROR);
  assert.notEqual(r.error, GATE_ERROR);
});

test("a multi-word line with no leading keyword is unknown", () => {
  const r = parseCommand("please scan foo.com", { listed: false });
  assert.equal(r.command, null);
  assert.equal(r.target, "");
  assert.match(String(r.error), /^Unknown command: "/);
});

test("unknown command truncates a long input to 40 chars", () => {
  const long = "a".repeat(60);
  const r = parseCommand(long, { listed: true });
  assert.equal(r.command, null);
  const error = String(r.error);
  assert.ok(error.includes(`"${"a".repeat(40)}"`), error);
  assert.ok(!error.includes("a".repeat(41)), "input was not truncated");
  assert.equal(r.echo, long, "echo is the full input even though the error is truncated");
});

test("echo is always the trimmed input, with the original casing", () => {
  assert.equal(parseCommand("  SCAN   Foo.COM  ", { listed: true }).echo, "SCAN   Foo.COM");
  assert.equal(parseCommand("LIST", { listed: false }).echo, "LIST");
  assert.equal(parseCommand(`  ${"x".repeat(60)}  `, { listed: false }).echo, "x".repeat(60));
});

test("HELP_LINES documents the four commands in order and the list rule", () => {
  const text = HELP_LINES.join("\n");
  const order = ["help", "list", "scan <domain>", "clear"].map((c) => text.indexOf(c));
  for (const [i, at] of order.entries()) {
    assert.ok(at >= 0, `missing ${["help", "list", "scan <domain>", "clear"][i]}`);
    if (i > 0) assert.ok(at > order[i - 1], "commands are out of order");
  }
  assert.match(text, /list.*before.*scan/i);
  assert.ok(HELP_LINES.length < 10, "help should stay short");
  for (const line of HELP_LINES) {
    // Leading spaces are the command column and are intentional; trailing
    // spaces would show up as ragged glyphs in a monospace terminal.
    assert.equal(line, line.trimEnd(), JSON.stringify(line));
    assert.ok(!line.includes("\n"), JSON.stringify(line));
    assert.ok(!line.includes("%"), JSON.stringify(line));
  }
});