import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  PROXY_UPSTREAM_TIMEOUT_MS,
  isTimeoutAbort,
  timedOut,
  upstreamSignal,
} from "./proxy-timeout.ts";
import { messageForStatus } from "./user-errors.ts";

/**
 * WHY THESE TESTS
 *     The deleted keep-awake workflow used to hide a cold backend behind a
 *     scheduled ping. What is left is the proxy's own deadline, and the point
 *     of it is that THIS process answers 504 at 55s rather than the platform
 *     killing the request at 60s with an HTML page the client cannot parse.
 *     So the assertions below are about the two things that make that true:
 *     the budget sits under the ceiling, and a real aborted fetch is told
 *     apart from a real refused connection. Source checks at the end confirm
 *     all four routes are actually wired to that logic.
 */

const here = dirname(fileURLToPath(import.meta.url));

// --- the budget sits under the platform ceiling ------------------------------

test("the upstream budget clears the shipped chain, sits under the ceiling, and does not pretend to cover the code-default chain", () => {
  // Two different chains, and only one of them fits inside any budget that is
  // legally usable here:
  //   - SHIPPED (`SCAN_TIMEOUT_CRTSH=15`): 15 + Cert Spotter 18 + Subfinder 10
  //     = 43s. The budget must clear this with slack, or a healthy backend on
  //     the shipped config times out.
  //   - CODE DEFAULT (`SCAN_TIMEOUT_CRTSH=30`): 30 + 18 + 10 = 58s, before the
  //     sequential NVD tail. The budget is deliberately BELOW this. It cannot
  //     be raised to cover it: any budget above 58s plus the tail would cross
  //     the 60s ceiling and hand the failure back to the edge as an opaque
  //     HTML kill. Shrinking the sequential fallback chain is the real fix.
  //     So do not "correct" this assertion by raising the constant past 58s -
  //     that trades a legible 504 for an illegible edge timeout.
  assert.ok(
    PROXY_UPSTREAM_TIMEOUT_MS > 43_000,
    "the budget must clear the 43s shipped-config certificate chain (15 + 18 + 10)",
  );
  // Vercel Hobby's function ceiling. Staying under it is the entire design:
  // the proxy answers first, instead of the edge.
  assert.ok(
    PROXY_UPSTREAM_TIMEOUT_MS < 60_000,
    "the budget must stay under the 60s Hobby ceiling so this proxy answers, not the edge",
  );
  // Recorded explicitly so the gap is intent, not an oversight: the
  // code-default chain is 58s and this budget is below it on purpose.
  assert.ok(
    PROXY_UPSTREAM_TIMEOUT_MS < 58_000,
    "below the 58s code-default chain by design; a larger value cannot fit under the ceiling",
  );
  // Pinned so a "round number" edit has to do it on purpose.
  assert.equal(PROXY_UPSTREAM_TIMEOUT_MS, 55_000);
  assert.equal(PROXY_UPSTREAM_TIMEOUT_MS / 1000, 55);
});

test("upstreamSignal returns a live signal that honours the budget", () => {
  const signal = upstreamSignal();
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, false, "the deadline must not already have passed");
});

// --- an aborted fetch is the deadline, not a missing service -----------------

/** A server that accepts the connection and never writes a response. */
async function hangingServer(): Promise<{ url: string; server: Server }> {
  const server = createServer(() => {
    // Deliberately silent: the client's only exit is its own deadline.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/`, server };
}

function close(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

test("a slow fetch aborted by a deadline is recognised, and answers 504", async () => {
  const { url, server } = await hangingServer();
  try {
    const error = await fetch(url, { signal: AbortSignal.timeout(25) }).then(
      () => null,
      (reason: unknown) => reason,
    );
    assert.ok(error !== null, "the hanging fetch must not resolve");
    assert.equal(
      isTimeoutAbort(error),
      true,
      "an AbortSignal.timeout rejection must classify as a timeout",
    );

    const response = timedOut();
    assert.equal(response.status, 504);
    assert.match(
      response.headers.get("content-type") ?? "",
      /application\/json/,
      "the error must stay parseable JSON, unlike the edge's HTML 504",
    );
    const body = (await response.json()) as { detail?: string };
    const seconds = PROXY_UPSTREAM_TIMEOUT_MS / 1000;
    assert.equal(
      body.detail,
      `The search service did not answer within ${seconds} seconds. ` +
        "It may still be starting up, or the search itself may be taking longer " +
        "than usual - wait about a minute and try again.",
    );
    // Names the fact and the next action, without asserting one cause (a cold
    // start and a slow-but-healthy scan both land here) or leaking the backend.
    assert.match(body.detail ?? "", /may still be starting up/);
    assert.match(body.detail ?? "", /may be taking longer than usual/);
    assert.ok(!/\bis starting up\b/.test(body.detail ?? ""), "a cause is not asserted as fact");
    assert.ok(!body.detail?.includes("localhost") && !body.detail?.includes("BACKEND_URL"));
  } finally {
    await close(server);
  }
});

test("a refused connection is NOT a timeout, so it stays 502", async () => {
  // Bind a port, then give it up: connecting now is refused, which is the
  // real shape of "the service is down", not "the service is slow".
  const server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await close(server);

  // Bounded on purpose. This fetch has no other exit: if the ephemeral port is
  // reused by a listener between `close` and `connect`, an unbounded fetch would
  // hang the whole `node --test` run forever (its default timeout is Infinity).
  // With a deadline it fails fast instead - the assertion below still has to
  // hold, so a reused port reads as a test failure, not a stuck suite.
  const error = await fetch(`http://127.0.0.1:${port}/`, {
    signal: AbortSignal.timeout(2000),
  }).then(
    () => null,
    (reason: unknown) => reason,
  );
  assert.ok(error !== null, "a refused connection must not resolve");
  assert.equal(
    isTimeoutAbort(error),
    false,
    "ECONNREFUSED / DNS failure must not be reported as a timeout",
  );
});

test("isTimeoutAbort accepts both abort names and nothing else", () => {
  assert.equal(isTimeoutAbort(new DOMException("timed out", "TimeoutError")), true);
  assert.equal(isTimeoutAbort(new DOMException("aborted", "AbortError")), true);
  // The plain-Error fallback for runtimes that keep the name but not the class.
  const plain = new Error("aborted");
  plain.name = "AbortError";
  assert.equal(isTimeoutAbort(plain), true);

  assert.equal(isTimeoutAbort(new TypeError("fetch failed")), false);
  assert.equal(isTimeoutAbort(new DOMException("nope", "NotFoundError")), false);
  assert.equal(isTimeoutAbort("TimeoutError"), false, "a string is not an abort");
  assert.equal(isTimeoutAbort(null), false);
});

// --- the user-facing sentence -------------------------------------------------

test("504 has its own sentence; the status code and raw detail never render", () => {
  const message = messageForStatus(504);
  assert.notEqual(
    message,
    messageForStatus(500),
    "504 must not collapse into the generic 5xx line",
  );
  assert.match(message, /did not answer in time/);
  assert.match(message, /wait about a minute and try again/);
  assert.ok(!message.includes("504"), "a status code is never the message");
  assert.ok(!message.includes("detail"), "the raw upstream detail never renders");
});

// --- all four routes are actually wired to it ---------------------------------

test("every API proxy route declares the ceiling, passes the signal, and splits 504 from 502", () => {
  const routes: Array<[string, string[]]> = [
    ["scan", ["app", "api", "scan", "[[...path]]", "route.ts"]],
    ["analysis", ["app", "api", "analysis", "[...path]", "route.ts"]],
    ["history", ["app", "api", "history", "route.ts"]],
    ["trend", ["app", "api", "trend", "[target]", "route.ts"]],
  ];

  for (const [name, segments] of routes) {
    const source = readFileSync(join(here, "..", ...segments), "utf8");
    assert.match(source, /export const maxDuration = 60;/, `${name}: must declare the Hobby ceiling`);
    assert.ok(source.includes("signal: upstreamSignal()"), `${name}: must pass the abort signal into fetch`);
    assert.ok(source.includes("isTimeoutAbort(error)"), `${name}: must detect the deadline`);
    assert.match(
      source,
      /isTimeoutAbort\(error\)[\s\S]*timedOut\(\)/,
      `${name}: must answer the deadline with 504`,
    );
    assert.ok(source.includes("502"), `${name}: must keep a 502 for a connection failure`);
  }

  // The two collection routes keep their readable 502 message (dashboard.test.ts
  // also pins this); the two scan proxies keep their original detail string.
  const history = readFileSync(join(here, "..", "app", "api", "history", "route.ts"), "utf8");
  const trend = readFileSync(join(here, "..", "app", "api", "trend", "[target]", "route.ts"), "utf8");
  for (const source of [history, trend]) {
    assert.ok(source.includes("messageForStatus(502)"), "a 502 must stay readable");
  }
  const scan = readFileSync(join(here, "..", "app", "api", "scan", "[[...path]]", "route.ts"), "utf8");
  const analysis = readFileSync(join(here, "..", "app", "api", "analysis", "[...path]", "route.ts"), "utf8");
  for (const source of [scan, analysis]) {
    assert.ok(
      source.includes('"The search service did not respond."'),
      "a 502 must keep its existing detail",
    );
  }
});

test("a timed-out scan still hands over the guest cookie it minted", () => {
  // The backend charges the guest's quota when it ADMITS the scan, so a 55s
  // abort does not undo the charge. Answering 504 without the Set-Cookie would
  // strand that charge on an id the caller never sees, and every retry would
  // mint a fresh guest - restarting GUEST_SCAN_LIMIT_PER_DAY.
  const scan = readFileSync(
    join(here, "..", "app", "api", "scan", "[[...path]]", "route.ts"),
    "utf8",
  );
  const timeoutBranch = scan.slice(scan.indexOf("if (isTimeoutAbort(error))"));
  assert.ok(
    timeoutBranch.includes('response.headers.append("set-cookie", guest.setCookie)'),
    "the 504 branch must re-append the minted guest cookie",
  );
});
