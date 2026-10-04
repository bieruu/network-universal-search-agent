import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

test("the fake dev-login route is removed", () => {
  const route = join(here, "..", "app", "dev-login", "route.ts");
  assert.equal(existsSync(route), false, "no route may mint an artificial auth session");
});
