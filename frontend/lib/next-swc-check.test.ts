import test from "node:test";
import assert from "node:assert/strict";

// `next dev` resolves its native compiler with require("@next/swc-<platform>")
// from node_modules/next/dist/build/swc. Node walks up the directory tree, so a
// stray `node_modules` in a parent folder can supply a binary built for a
// different Next version - which then rejects the 15.x SWC options object:
//   unknown field 'disablePageConfig'  →  ENOENT .next/fallback-build-manifest.json
// The check script is pure so the verdicts can be tested without touching the
// real install; these tests pin the cases that actually break `dev`.
import { compareNextSwc, isInside, swcPackageFor } from "../scripts/check-next-swc.mjs";

const PROJECT = "C:\\work\\app\\frontend";
const LOCAL = "C:\\work\\app\\frontend\\node_modules\\@next\\swc-win32-x64-msvc";
const STRAY = "C:\\Users\\dev\\node_modules\\@next\\swc-win32-x64-msvc";
const NAME = "@next/swc-win32-x64-msvc";

test("matching versions inside the project are accepted", () => {
  const verdict = compareNextSwc({
    nextVersion: "15.5.28",
    swcVersion: "15.5.28",
    swcPath: LOCAL,
    projectDir: PROJECT,
    packageName: NAME,
  });
  assert.equal(verdict.status, "ok");
  assert.equal(verdict.ok, true);
  assert.equal(verdict.message, "");
});

test("a different version is flagged and names both versions, the path and the fix", () => {
  const verdict = compareNextSwc({
    nextVersion: "15.5.28",
    swcVersion: "16.3.8",
    swcPath: LOCAL,
    projectDir: PROJECT,
    packageName: NAME,
  });
  assert.equal(verdict.status, "mismatch");
  assert.equal(verdict.ok, false);
  assert.match(verdict.message, /15\.5\.28/);
  assert.match(verdict.message, /16\.3\.8/);
  assert.match(verdict.message, /disablePageConfig/);
  assert.ok(verdict.message.includes(LOCAL), "message should show the resolved path");
  assert.ok(
    verdict.message.includes(`npm install ${NAME}@15.5.28 --no-save --no-package-lock`),
    "message should carry the runnable fix",
  );
});

test("a binding resolved outside the project is flagged even when the version matches", () => {
  const verdict = compareNextSwc({
    nextVersion: "15.5.28",
    swcVersion: "15.5.28",
    swcPath: STRAY,
    projectDir: PROJECT,
    packageName: NAME,
  });
  assert.equal(verdict.status, "outside");
  assert.equal(verdict.ok, false);
  assert.match(verdict.message, /OUTSIDE the project/);
  assert.ok(verdict.message.includes(STRAY));
});

test("a missing binding is flagged with the install command", () => {
  const verdict = compareNextSwc({
    nextVersion: "15.5.28",
    swcVersion: null,
    swcPath: null,
    projectDir: PROJECT,
    packageName: NAME,
  });
  assert.equal(verdict.status, "missing");
  assert.equal(verdict.ok, false);
  assert.match(verdict.message, /not installed/);
  assert.match(verdict.message, /npm install @next\/swc-win32-x64-msvc@15\.5\.28/);
});

test("no local Next install means nothing to judge", () => {
  const verdict = compareNextSwc({
    nextVersion: null,
    swcVersion: "16.3.8",
    swcPath: STRAY,
    projectDir: PROJECT,
    packageName: NAME,
  });
  assert.equal(verdict.status, "skipped");
  assert.equal(verdict.ok, true);
});

test("containment does not accept a sibling folder sharing the prefix", () => {
  assert.equal(isInside(PROJECT, LOCAL, true), true);
  assert.equal(isInside(PROJECT, "C:\\work\\app\\frontend-other\\node_modules", true), false);
  assert.equal(isInside(PROJECT, PROJECT, true), true);
});

test("the platform binding name follows Next's per-platform packages", () => {
  assert.equal(swcPackageFor("win32", "x64"), "@next/swc-win32-x64-msvc");
  assert.equal(swcPackageFor("win32", "arm64"), "@next/swc-win32-arm64-msvc");
  assert.equal(swcPackageFor("darwin", "arm64"), "@next/swc-darwin-arm64");
  assert.match(swcPackageFor("linux", "x64") ?? "", /^@next\/swc-linux-x64-(gnu|musl)$/);
  assert.equal(swcPackageFor("freebsd", "x64"), null);
});
