import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  ANALYSIS_PROXY_PREFIX,
  AnalysisError,
  analysisProxyPath,
  encodeAnalysisSegment,
  getCapabilities,
  lookupPhone,
  normalizeAnalysisResponse,
  runAnalysis,
} from "./analysis-api.ts";

const here = dirname(fileURLToPath(import.meta.url));
const analysisRouteSrc = readFileSync(join(here, "..", "app", "api", "analysis", "[...path]", "route.ts"), "utf8");

/** Comments explain why the backend URL is server-only; the code must still be. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const analysisApiCode = stripComments(readFileSync(join(here, "analysis-api.ts"), "utf8"));

// The REAL installed Next helpers, not a reimplementation. This suite exists to
// pin what Next hands a route handler for an encoded path segment, because the
// proxy's answer depends on it: `decodePathParams` is what turns the browser's
// `%2F` back into the text `%2F` before this repo's code ever sees it. If an
// upgrade changes that, this file fails here instead of the phone lookup
// quietly arriving at the backend as a literal "%2F".
const nodeRequire = createRequire(import.meta.url);
const { decodePathParams } = nodeRequire("next/dist/server/lib/router-utils/decode-path-params.js") as {
  decodePathParams: (pathname: string) => string;
};

/** What the `[...path]` handler receives as `params.path`. */
function nextPathParams(proxyPath: string): string[] {
  return decodePathParams(proxyPath).split("/").slice(ANALYSIS_PROXY_PREFIX.split("/").length);
}

/**
 * Browser request → Next's decoded params → the proxy's outbound URL → what
 * Starlette's `unquote` gives the backend's `{number:path}` parameter.
 *
 * `decodeURIComponent` is used for that last step because it matches Starlette's
 * `unquote` for a path segment: neither turns `+` into a space (that is a query
 * string rule, and a phone number's leading `+` is a real character).
 */
function backendSeesPhoneNumber(number: string): string {
  const upstream = `/api/v1/analysis/${nextPathParams(analysisProxyPath("phone", [number]))
    .map(encodeAnalysisSegment)
    .join("/")}`;
  return decodeURIComponent(upstream);
}

interface Recorded {
  url: string;
  init: RequestInit;
}

/** Replace global fetch for the duration of one test and record every call. */
function withFetch(
  responder: (url: string, init: RequestInit) => Response | Promise<Response>,
): { calls: Recorded[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: Recorded[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls.push({ url: String(input), init: init ?? {} });
    return responder(String(input), init ?? {});
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
}

const ENVELOPE = {
  capability: "headers",
  target: "https://example.com/",
  source: "http_headers",
  status: "ok",
  data: { status_code: 200 },
  errors: [],
  fetched_at: "2026-01-01T00:00:00+00:00",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function envelope(over: Record<string, unknown> = {}): Response {
  return json({ ...ENVELOPE, ...over });
}

// --- the phone path segment survives the proxy -------------------------------

test("a phone number with + and / survives the proxy round trip", () => {
  for (const number of [
    "+15551234",
    "+1 (555) 010-9999",
    "+1/555/010",
    "0044 20 7946 0958",
    "+62 812-3456-7890",
    "50%",
    "%",
    "a#b?c",
  ]) {
    assert.equal(
      backendSeesPhoneNumber(number),
      `/api/v1/analysis/phone/${number}`,
      JSON.stringify(number),
    );
  }
});

test("Next hands the handler a decoded segment, which is why blind re-encoding is wrong", () => {
  // Pin the installed behaviour this file's other assertions lean on.
  assert.deepEqual(nextPathParams("/api/analysis/phone/%2B1%2F555"), ["phone", "+1%2F555"]);
  // `+` decodes to itself and is NOT re-escaped, so plain encodeURIComponent is
  // already correct for it (`%2B` → `+` → `%2B`).
  assert.deepEqual(nextPathParams("/api/analysis/phone/%2B1555"), ["phone", "+1555"]);
  // A `/` comes back as the TEXT `%2F`, so encoding it again would send
  // `%252F` and the backend would decode the literal "%2F" instead of "/".
  assert.deepEqual(nextPathParams("/api/analysis/phone/%2F"), ["phone", "%2F"]);
  assert.equal(encodeAnalysisSegment("%2F"), "%2F", "an existing escape is passed through");
  assert.equal(encodeAnalysisSegment("+1/555"), "%2B1%2F555");
});

test("encoding a segment escapes what needs it and drops nothing", () => {
  assert.equal(encodeAnalysisSegment("phone"), "phone");
  assert.equal(encodeAnalysisSegment("+1555"), "%2B1555");
  assert.equal(encodeAnalysisSegment("a b"), "a%20b");
  // Not a valid escape, so it is encoded rather than left to break the URL.
  assert.equal(encodeAnalysisSegment("%zz"), "%25zz");
  assert.equal(encodeAnalysisSegment("%2"), "%252");
});

// --- the client talks to the proxy, and only the proxy -----------------------

test("runAnalysis POSTs the body to the proxy path", async () => {
  const stub = withFetch(() => envelope({ capability: "dns" }));
  try {
    await runAnalysis("dns", { target: "Example.COM.", force: true });
  } finally {
    stub.restore();
  }
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].url, "/api/analysis/dns");
  assert.equal(stub.calls[0].init.method, "POST");
  assert.equal(stub.calls[0].init.headers && (stub.calls[0].init.headers as Record<string, string>)["content-type"], "application/json");
  assert.deepEqual(JSON.parse(String(stub.calls[0].init.body)), { target: "Example.COM.", force: true });
});

test("no capability call ever leaves the browser for a backend host", async () => {
  const stub = withFetch((url) => (url.endsWith("capabilities") ? json({ always_available: ["dns"], optional_sources: { urlscan: true } }) : envelope()));
  try {
    await runAnalysis("headers", { url: "https://example.com" });
    await lookupPhone("+15551234");
    await getCapabilities();
  } finally {
    stub.restore();
  }
  assert.equal(stub.calls.length, 3);
  for (const call of stub.calls) {
    assert.ok(call.url.startsWith(`${ANALYSIS_PROXY_PREFIX}/`), `not a proxy path: ${call.url}`);
    assert.ok(!/^https?:\/\//i.test(call.url), `absolute URL reaches the client: ${call.url}`);
  }
  assert.equal(stub.calls[1].url, "/api/analysis/phone/%2B15551234");
  assert.equal(stub.calls[2].url, "/api/analysis/capabilities");
  assert.equal(stub.calls[2].init.method, "GET");
  // The backend URL is server-only and must not appear in a module the browser loads.
  assert.ok(!analysisApiCode.includes("BACKEND_URL"), "the client module must not read BACKEND_URL");
  assert.ok(!analysisApiCode.includes("localhost:8000"), "the client module must not name a backend host");
  assert.ok(!/NEXT_PUBLIC_/.test(analysisApiCode), "no analysis setting may be a public env var");
});

test("lookupPhone normalizes the envelope it gets back", async () => {
  const stub = withFetch(() => envelope({ capability: "phone", target: "+15551234", source: "phone_lookup" }));
  try {
    const res = await lookupPhone<{ valid: boolean }>("+15551234");
    assert.equal(res.capability, "phone");
    assert.equal(res.target, "+15551234");
    assert.equal(res.status, "ok");
    assert.deepEqual(res.errors, []);
    assert.equal(res.data.valid, undefined);
  } finally {
    stub.restore();
  }
});

// --- failures are typed and say what a user can do ---------------------------
//
// These assertions used to require the backend's own `detail` to reach the UI
// verbatim. The copy audit (2026-10-10) reversed that on purpose: `detail`
// carries raw FastAPI validation arrays and provider exception prose, which is
// untrusted (AGENTS.md §5.4) and unreadable. The message is now mapped from the
// status; the upstream text survives on `technicalDetail` for the console.
// The regression these tests must keep locked is that NEITHER string leaks into
// the user-facing `detail`.

test("an expired session reads as a sign-in problem, not a crash", async () => {
  const stub = withFetch(() => json({ detail: "Not authenticated" }, 401));
  try {
    await assert.rejects(() => runAnalysis("dns", { target: "example.com" }), (err: unknown) => {
      assert.ok(err instanceof AnalysisError);
      assert.equal(err.status, 401);
      assert.match(err.detail, /session/i);
      assert.match(err.detail, /sign in/i);
      return true;
    });
  } finally {
    stub.restore();
  }
});

test("a rate limit names the limit and a retry horizon, never 'try again later'", async () => {
  const stub = withFetch(() => json({ detail: "Rate limit exceeded" }, 429));
  try {
    await assert.rejects(() => runAnalysis("headers", { url: "https://example.com" }), (err: unknown) => {
      assert.ok(err instanceof AnalysisError);
      assert.equal(err.status, 429);
      assert.match(err.detail, /limit/i);
      assert.ok(!/try again later/i.test(err.detail), err.detail);
      return true;
    });
  } finally {
    stub.restore();
  }
});

test("the proxy's 502 is not restated as its own plumbing detail", async () => {
  const stub = withFetch(() => json({ detail: "Backend unreachable" }, 502));
  try {
    await assert.rejects(() => runAnalysis("dns", { target: "example.com" }), (err: unknown) => {
      assert.ok(err instanceof AnalysisError);
      assert.equal(err.status, 502);
      // "Backend unreachable" is infrastructure vocabulary: it names the hop,
      // not what the reader should do.
      assert.ok(!err.detail.toLowerCase().includes("backend"), err.detail);
      assert.ok(!/\b50\d\b/.test(err.detail), err.detail);
      // ...but the evidence survives for the console.
      assert.match(String(err.technicalDetail), /Backend unreachable/);
      return true;
    });
  } finally {
    stub.restore();
  }
});

test("a caller mistake maps to actionable copy, not the upstream reason", async () => {
  for (const status of [400, 413, 422]) {
    const stub = withFetch(() => json({ detail: "Target resolves to a blocked address" }, status));
    try {
      await assert.rejects(() => runAnalysis("headers", { url: "http://169.254.169.254" }), (err: unknown) => {
        assert.ok(err instanceof AnalysisError);
        assert.equal(err.status, status);
        assert.ok(!err.detail.includes("169.254"), err.detail);
        assert.ok(!/blocked address/i.test(err.detail), err.detail);
        return true;
      });
    } finally {
      stub.restore();
    }
  }
});

test("a FastAPI validation list never reaches the message, but is kept for logs", async () => {
  const detail = [{ loc: ["body", "target"], msg: "too short" }];
  const stub = withFetch(() => json({ detail }, 422));
  try {
    await assert.rejects(() => runAnalysis("dns", { target: "" }), (err: unknown) => {
      assert.ok(err instanceof AnalysisError);
      assert.ok(!err.detail.includes("too short"), err.detail);
      assert.ok(!err.detail.includes("loc"), err.detail);
      assert.ok(err.detail.length <= 301);
      assert.match(String(err.technicalDetail), /too short/);
      return true;
    });
  } finally {
    stub.restore();
  }
});

test("an unparseable body is a clear error, not a JSON syntax error", async () => {
  const stub = withFetch(
    () =>
      new Response("<html><body>502 Bad Gateway</body></html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
  );
  try {
    await assert.rejects(() => runAnalysis("sitemap", { url: "https://example.com" }), (err: unknown) => {
      assert.ok(err instanceof AnalysisError);
      assert.equal(err.status, 502);
      // The page is untrusted third-party text and is never rendered back.
      assert.ok(!err.detail.includes("<html>"), err.detail);
      assert.ok(!err.detail.includes("502"), err.detail);
      return true;
    });
  } finally {
    stub.restore();
  }
});

test("a 200 with an empty body is an error too, not a hang or a parse crash", async () => {
  const stub = withFetch(() => new Response("", { status: 200 }));
  try {
    await assert.rejects(() => runAnalysis("dns", { target: "example.com" }), (err: unknown) => {
      assert.ok(err instanceof AnalysisError);
      assert.match(err.detail, /unexpected reply/i);
      return true;
    });
  } finally {
    stub.restore();
  }
});

test("a transport failure never escapes as a raw fetch TypeError", async () => {
  const stub = withFetch(() => {
    throw new TypeError("fetch failed");
  });
  try {
    await assert.rejects(() => runAnalysis("dns", { target: "example.com" }), (err: unknown) => {
      assert.ok(err instanceof AnalysisError);
      assert.equal(err.status, 0);
      // "proxy" names the hop, not the reader's problem or their next action.
      assert.ok(!err.detail.includes("proxy"), err.detail);
      assert.match(err.detail, /check your connection/i);
      return true;
    });
  } finally {
    stub.restore();
  }
});

// --- a failed capability is a 200 to render, not an exception -----------------

test("a capability failure resolves with status error and errors[] intact", async () => {
  const stub = withFetch(() =>
    envelope({
      capability: "contacts",
      target: "https://example.com/",
      source: "",
      status: "error",
      data: {},
      errors: [{ source: "contacts", message: "Refused: target resolves to a blocked address" }],
    }),
  );
  try {
    const res = await runAnalysis("contacts", { url: "https://example.com" });
    assert.equal(res.status, "error");
    assert.deepEqual(res.errors, [
      { source: "contacts", message: "Refused: target resolves to a blocked address" },
    ]);
    // A blocked target must never read as "no findings".
    assert.notEqual(res.status, "ok");
    assert.deepEqual(res.data, {});
  } finally {
    stub.restore();
  }
});

test("force is forwarded, because a cached answer is not a fresh one", async () => {
  const stub = withFetch(() => envelope());
  try {
    await runAnalysis("tls", { target: "example.com", force: true });
    await runAnalysis("tls", { target: "example.com" });
  } finally {
    stub.restore();
  }
  assert.deepEqual(JSON.parse(String(stub.calls[0].init.body)), { target: "example.com", force: true });
  assert.deepEqual(JSON.parse(String(stub.calls[1].init.body)), { target: "example.com" });
});

// --- normalization is total --------------------------------------------------

test("a malformed or empty envelope degrades instead of crashing a card", () => {
  for (const payload of [null, undefined, 42, "nope", []]) {
    const res = normalizeAnalysisResponse(payload);
    assert.equal(res.capability, "");
    assert.equal(res.target, "");
    assert.equal(res.source, "");
    assert.equal(res.status, "ok");
    assert.deepEqual(res.data, {});
    assert.deepEqual(res.errors, []);
    assert.equal(res.fetched_at, "");
  }
  const partial = normalizeAnalysisResponse({ capability: "dns", data: "not an object", errors: "nope" });
  assert.deepEqual(partial.data, {});
  assert.deepEqual(partial.errors, []);
  assert.deepEqual(normalizeAnalysisResponse({ status: "error", data: { a: 1 } }).data, { a: 1 });
});

test("error entries that are not the documented shape are dropped, not rendered raw", () => {
  assert.deepEqual(normalizeAnalysisResponse({ errors: [{ source: "s" }, "nope", null, { source: "s", message: "m" }] }).errors, [
    { source: "s", message: "m" },
  ]);
});

test("capabilities normalizes to strings and real booleans", async () => {
  const stub = withFetch(() =>
    json({ always_available: ["headers", 7, "dns"], optional_sources: { urlscan: true, defacement: 1, leaklookup: null } }),
  );
  try {
    const caps = await getCapabilities();
    assert.deepEqual(caps.always_available, ["headers", "dns"]);
    assert.deepEqual(caps.optional_sources, { urlscan: true, defacement: false, leaklookup: false });
  } finally {
    stub.restore();
  }
  const empty = withFetch(() => json({}));
  try {
    assert.deepEqual(await getCapabilities(), { always_available: [], optional_sources: {} });
  } finally {
    empty.restore();
  }
});

// --- the proxy route itself --------------------------------------------------

test("the proxy forwards the session and never a backend URL to the client", () => {
  assert.match(analysisRouteSrc, /process\.env\.BACKEND_URL \?\? "http:\/\/localhost:8000"/);
  assert.match(analysisRouteSrc, /req\.headers\.get\("cookie"\)/);
  assert.match(analysisRouteSrc, /req\.headers\.get\("authorization"\)/);
  assert.ok(analysisRouteSrc.includes("/api/v1/analysis/"), "the backend prefix must be /api/v1/analysis");
  assert.ok(
    analysisRouteSrc.includes("path.map(encodeAnalysisSegment)"),
    "every path segment must be encoded individually (a phone number is a segment)",
  );
  assert.ok(
    analysisRouteSrc.includes('{ detail: "The search service did not respond." }'),
    "transport failure must be a 502 with an honest detail, not plumbing vocabulary",
  );
  assert.ok(
    !analysisRouteSrc.includes("Backend unreachable"),
    'the detail must not read as "Backend unreachable" — it names plumbing the user cannot act on',
  );
  assert.ok(analysisRouteSrc.includes("status: 502"));
  // Both verbs are needed: phone and capabilities are GETs, the rest are POSTs.
  assert.match(analysisRouteSrc, /export async function GET/);
  assert.match(analysisRouteSrc, /export async function POST/);
  assert.ok(!analysisRouteSrc.includes("process.env.SHODAN"), "no API key handling in the proxy");
});