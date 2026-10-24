import test from "node:test";
import assert from "node:assert/strict";

import {
  PROXY_MAX_BODY_BYTES,
  PayloadTooLargeError,
  collectBounded,
  declaredLength,
  declaredTooLarge,
  requestBodyChunks,
} from "./proxy-body.ts";

/**
 * These tests exist because the guard's whole value is a memory bound. The
 * failure they lock out is a request body being buffered before anything said
 * no: an oversized upload reaching the Node server on the way to a backend that
 * would answer 401 anyway. So the assertions below care less about the decoded
 * string than about WHEN the read is abandoned - the counting path must refuse
 * on the chunk that crosses the cap, not after slurping the whole body.
 */

/** An async iterable of byte chunks, exactly like a real body would hand us. */
async function* fromChunks(chunks: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) yield chunk;
}

/** A header getter that answers with one fixed value for any name. */
function header(value: string | null): (name: string) => string | null {
  return () => value;
}

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

// --- the cap is shared with the backend, not invented here -------------------

test("the proxy cap equals the backend's MAX_REQUEST_BODY_BYTES (16 MiB)", () => {
  // backend/app/core/config.py: `max_request_body_bytes` defaults to
  // `16 * 1024 * 1024`. The two constants MUST NOT drift in either direction:
  //   - proxy looser than the backend  -> the proxy forwards a body the backend
  //     was always going to reject, spending the memory twice for nothing.
  //   - proxy tighter than the backend  -> a body the backend would have
  //     accepted is refused early, a spurious 413 for a legitimate request.
  // The buffer-friendly value 16777216 is spelled out so a bad "round number"
  // refactor cannot slip through unnoticed.
  assert.equal(PROXY_MAX_BODY_BYTES, 16 * 1024 * 1024);
  assert.equal(PROXY_MAX_BODY_BYTES, 16777216);
});

// --- a body within the cap is read and decoded correctly ---------------------

test("a multi-chunk body under the limit is concatenated and decoded", async () => {
  const text = '{"target":"example.com","force":true,"note":"a body that spans three chunks"}';
  const all = new TextEncoder().encode(text);
  const chunks = [all.slice(0, 10), all.slice(10, 33), all.slice(33)];
  assert.equal(chunks.length, 3);
  const out = await collectBounded(fromChunks(chunks));
  assert.equal(out, text);
});

test("an empty body decodes to an empty string, not null or undefined", async () => {
  assert.equal(await collectBounded(fromChunks([])), "");
  // A stream that yields a single zero-length chunk is also an empty body.
  assert.equal(await collectBounded(fromChunks([bytes()])), "");
});

test("a multi-byte UTF-8 char split across a chunk boundary decodes correctly", async () => {
  // This is WHY the chunks are concatenated before decoding. Decoding each
  // chunk on its own would turn the halves of "é"/"😀" into replacement chars,
  // because a per-chunk TextDecoder has no way to carry a partial code point
  // forward. One merged buffer, one decode, and the bytes reassemble.
  const text = "café😀 résumé";
  const all = new TextEncoder().encode(text);
  // Split at the FIRST continuation byte (0x80..0xBF), i.e. the middle of a
  // multi-byte sequence, so a naive per-chunk decode would be provably wrong.
  let splitAt = -1;
  for (let i = 1; i < all.length; i += 1) {
    if ((all[i] & 0xc0) === 0x80) {
      splitAt = i;
      break;
    }
  }
  assert.ok(splitAt > 0, "the fixture must actually split inside a code point");
  const out = await collectBounded(fromChunks([all.slice(0, splitAt), all.slice(splitAt)]));
  assert.equal(out, text);
});

test("a body of exactly `limit` bytes is accepted; one byte more is not", async () => {
  assert.equal(await collectBounded(fromChunks([bytes(...new Array(10).fill(65))]), 10), "AAAAAAAAAA");
  await assert.rejects(() => collectBounded(fromChunks([bytes(...new Array(11).fill(65))]), 10));
});

// --- the read is abandoned the moment the cap is crossed ---------------------

test("a single chunk larger than the limit is refused, not buffered", async () => {
  let sourceClosed = false;
  let secondChunkRead = false;
  async function* oversized(): AsyncGenerator<Uint8Array> {
    try {
      yield bytes(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11); // 11 > limit 10
      secondChunkRead = true;
      yield bytes(1);
    } finally {
      sourceClosed = true;
    }
  }
  // The increment happens BEFORE the push, so the offending chunk never lands
  // in the accumulator and the next one is never requested.
  await assert.rejects(
    () => collectBounded(oversized(), 10),
    (err: unknown) => {
      assert.ok(err instanceof PayloadTooLargeError, "must be the typed error, not a raw throw");
      assert.equal(err.limitBytes, 10);
      assert.match(err.message, /exceeds the 10-by/);
      return true;
    },
  );
  assert.equal(sourceClosed, true, "breaking the loop must run the source's finally (cancel the upload)");
  assert.equal(secondChunkRead, false, "the oversized chunk is refused, so the source is never resumed");
});

test("a body that only exceeds the limit on the last chunk still throws", async () => {
  let sourceClosed = false;
  async function* creeping(): AsyncGenerator<Uint8Array> {
    try {
      yield bytes(1, 2, 3, 4); // total 4
      yield bytes(1, 2, 3, 4); // total 8
      yield bytes(1, 2, 3, 4); // total 12 > 10
      yield bytes(1); // never reached
    } finally {
      sourceClosed = true;
    }
  }
  await assert.rejects(() => collectBounded(creeping(), 10), PayloadTooLargeError);
  assert.equal(sourceClosed, true);
});

test("limit <= 0 disables the cap and reads everything", async () => {
  const text = "x".repeat(1000);
  const all = new TextEncoder().encode(text);
  assert.equal(await collectBounded(fromChunks([all]), 0), text);
  assert.equal(await collectBounded(fromChunks([all]), -1), text);
});

// --- the declared length is a cheap refusal before any read ------------------

test("declaredLength reads a usable number and rejects garbage/negatives", () => {
  assert.equal(declaredLength(header("1024")), 1024);
  assert.equal(declaredLength(header(String(PROXY_MAX_BODY_BYTES + 1))), PROXY_MAX_BODY_BYTES + 1);
  assert.equal(declaredLength(header("0")), 0);
  assert.equal(declaredLength(header(null)), null, "no header");
  assert.equal(declaredLength(header("not-a-number")), null, "malformed garbage");
  assert.equal(declaredLength(header("12abc")), null, "trailing junk is not a size");
  assert.equal(declaredLength(header("-5")), null, "a negative length is unusable");
});

test("declaredTooLarge refuses on size alone and never on a missing header", () => {
  // Over the cap -> refuse.
  assert.equal(declaredTooLarge(header(String(PROXY_MAX_BODY_BYTES + 1))), true);
  // Under the cap, exactly at it, absent, garbage, negative, "0" -> never refuse.
  assert.equal(declaredTooLarge(header("100")), false);
  assert.equal(declaredTooLarge(header(String(PROXY_MAX_BODY_BYTES))), false, "at the cap is allowed");
  assert.equal(declaredTooLarge(header(null)), false);
  assert.equal(declaredTooLarge(header("not-a-number")), false);
  assert.equal(declaredTooLarge(header("-5")), false);
  assert.equal(declaredTooLarge(header("0")), false);
  // And it honours a caller-supplied limit.
  assert.equal(declaredTooLarge(header("100"), 50), true);
  assert.equal(declaredTooLarge(header("100"), 100), false);
});

// --- chunking a real body stream ---------------------------------------------

test("requestBodyChunks yields nothing for a null/undefined body", async () => {
  for (const body of [null, undefined]) {
    const seen: number[] = [];
    for await (const chunk of requestBodyChunks(body)) seen.push(...chunk);
    assert.deepEqual(seen, []);
  }
});

test("requestBodyChunks yields every chunk of a ReadableStream", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes(1, 2, 3));
      controller.enqueue(bytes(4, 5));
      controller.close();
    },
  });
  const seen: number[] = [];
  for await (const chunk of requestBodyChunks(stream)) seen.push(...chunk);
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
});

test("requestBodyChunks cancels the stream when the consumer stops early", async () => {
  // The size-cap case: the consumer walks away mid-body, so the underlying
  // upload must be cancelled rather than drained into a response we abandoned.
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes(1, 2, 3));
      controller.enqueue(bytes(4, 5, 6));
      controller.enqueue(bytes(7, 8, 9));
    },
    cancel() {
      cancelled = true;
    },
  });
  const seen: number[] = [];
  for await (const chunk of requestBodyChunks(stream)) {
    seen.push(...chunk);
    break; // abandon after the first chunk
  }
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(cancelled, true, "an early-returning consumer must cancel the upload");
  // Unlike the completed-stream path, the cancel branch does NOT release the
  // lock (it cancels instead), so the reader stays held. What matters is that
  // the upload was aborted, asserted above - a leaked lock here is reclaimable,
  // whereas an undrained hostile body is not.
  assert.equal(stream.locked, true);
});

test("requestBodyChunks releases the lock without cancelling a completed stream", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes(1));
      controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  const seen: number[] = [];
  for await (const chunk of requestBodyChunks(stream)) seen.push(...chunk);
  assert.deepEqual(seen, [1]);
  assert.equal(cancelled, false, "a body that finished sending is not cancelled");
  assert.equal(stream.locked, false, "the lock is released so the stream can drain normally");
});
