import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The landing page crashed at "Application error: a client-side exception"
// because Next.js App Router bundles its OWN React (next/dist/compiled/react -
// a React 19 canary) for the client layer, regardless of what react version
// package.json declares. The manifest said react ^18.3.1 while the runtime
// was React 19, and @react-three/fiber v8 pulled react-reconciler 0.27, which
// reads React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED - a key React
// 19 removed (renamed to __CLIENT_INTERNALS_...). ReactSharedInternals came
// back undefined, and the reconciler threw on
// `ReactSharedInternals.ReactCurrentOwner` at module init, so every chunk that
// imported @react-three/fiber died before rendering.
//
// So the contract is: the declared client stack must be React-19-compatible.
// These checks read the manifest + lockfile (both tracked) and fail loudly if
// anyone pins the stack back onto the React-18 line.
const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
};
const lock = JSON.parse(readFileSync(join(here, "..", "package-lock.json"), "utf8")) as {
  packages: Record<string, { version?: string } | undefined>;
};

/** First number of an npm range: "^19.3.0" → 19, "15.5.27" → 15. */
const majorOf = (range: string): number => {
  const m = /(\d+)/.exec(range ?? "");
  return m ? Number(m[1]) : Number.NaN;
};

test("react and react-dom declare the React 19 line that the App Router actually runs", () => {
  assert.ok(
    majorOf(pkg.dependencies.react) >= 19,
    `react must be on the ^19 line (App Router client bundles execute React 19 canary from next/dist/compiled), got "${pkg.dependencies.react}"`,
  );
  assert.ok(
    majorOf(pkg.dependencies["react-dom"]) >= 19,
    `react-dom must be on the ^19 line to pair with react, got "${pkg.dependencies["react-dom"]}"`,
  );
});

test("the 3D stack is on the React-19 line: @react-three/fiber v9+, drei v10+", () => {
  assert.ok(
    majorOf(pkg.dependencies["@react-three/fiber"]) >= 9,
    `@react-three/fiber must be ^9 (v8 uses react-reconciler 0.27, which crashes on React 19), got "${pkg.dependencies["@react-three/fiber"]}"`,
  );
  assert.ok(
    majorOf(pkg.dependencies["@react-three/drei"]) >= 10,
    `@react-three/drei must be ^10 to pair with fiber v9 (v9 peers fiber ^8 / react ^18), got "${pkg.dependencies["@react-three/drei"]}"`,
  );
});

test("the lockfile carries no React-18-era react-reconciler", () => {
  const rec = lock.packages["node_modules/react-reconciler"];
  // fiber v9 builds the reconciler into its own bundle, so the package being
  // absent is the healthy state. If it reappears it must be on the React 19
  // line: 0.31+ pairs with React 19 (0.27 is the React 18 line that reads the
  // removed __SECRET_INTERNALS key and crashed the landing page).
  if (rec?.version) {
    const minor = Number(rec.version.split(".")[1]);
    assert.ok(
      minor >= 31,
      `react-reconciler ${rec.version} pairs with React 18 (0.31+ is required for React 19) - it crashes on next/dist/compiled/react's missing __SECRET_INTERNALS`,
    );
  }
});
