/**
 * Bounded request-body reads for the API proxy routes.
 *
 * WHY THIS EXISTS
 *     The proxies under `app/api/**` sit in front of the backend, but they are
 *     NOT where authentication happens - `middleware.ts` matches only
 *     `/dashboard/:path*`, and the real gate is the backend's `require_user()`.
 *     Route handlers also read the whole body before any of that matters
 *     (`await req.text()`), and a Next.js App Router route handler has no
 *     bodyParser size limit the way a Pages Router `api/` route does.
 *
 *     Net effect before this module: an anonymous caller could make the Node
 *     server buffer an arbitrarily large JSON document on the way to being
 *     forwarded to a backend that would answer 401. The payload was spent in
 *     memory twice over - once here, once in the backend worker - before
 *     anything said no.
 *
 *     The guard is deliberately in `lib/` and free of Next imports so it can be
 *     exercised directly by `node --test` with a plain async generator.
 */

/** Must not exceed the backend's own `MAX_REQUEST_BODY_BYTES` (16 MiB). */
export const PROXY_MAX_BODY_BYTES = 16 * 1024 * 1024;

export class PayloadTooLargeError extends Error {
  readonly limitBytes: number;

  constructor(limitBytes: number) {
    super(`Request body exceeds the ${limitBytes}-byte proxy limit`);
    this.name = "PayloadTooLargeError";
    this.limitBytes = limitBytes;
  }
}

/**
 * Read `source` to a string, throwing {@link PayloadTooLargeError} the moment
 * more than `limit` bytes have arrived.
 *
 * Pure on purpose: `source` is any async iterable of byte chunks, so a test can
 * pass a generator. `limit <= 0` disables the check and reads everything, which
 * mirrors the backend middleware's opt-out.
 */
export async function collectBounded(
  source: AsyncIterable<Uint8Array>,
  limit: number = PROXY_MAX_BODY_BYTES,
): Promise<string> {
  if (limit <= 0) {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of source) {
      total += chunk.byteLength;
      chunks.push(chunk);
    }
    return concatDecode(chunks, total);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  // The increment happens BEFORE the push, so a single chunk larger than the
  // limit is refused rather than buffered. Breaking out of the loop also runs
  // the generator's `finally`, which is how the underlying upload gets
  // cancelled instead of draining into a response we already abandoned.
  for await (const chunk of source) {
    total += chunk.byteLength;
    if (total > limit) throw new PayloadTooLargeError(limit);
    chunks.push(chunk);
  }
  return concatDecode(chunks, total);
}

function concatDecode(chunks: Uint8Array[], total: number): string {
  if (total === 0) return "";
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/** The declared size, or `null` when there is no usable Content-Length. */
export function declaredLength(
  get: (name: string) => string | null,
): number | null {
  const raw = get("content-length");
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * True when the request can be refused on its declared size alone.
 *
 * Cheaper and safer than reading: no byte of the body is touched, so a
 * multi-gigabyte upload never enters this process at all.
 */
export function declaredTooLarge(
  get: (name: string) => string | null,
  limit: number = PROXY_MAX_BODY_BYTES,
): boolean {
  const declared = declaredLength(get);
  return declared !== null && declared > limit;
}

/** Byte chunks of a request body, cancelled if the consumer stops early. */
export async function* requestBodyChunks(
  body: ReadableStream<Uint8Array> | null | undefined,
): AsyncGenerator<Uint8Array, void, undefined> {
  if (!body) return;
  const reader = body.getReader();
  let completed = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        return;
      }
      if (value) yield value;
    }
  } finally {
    // `completed` means the client finished sending: release the lock and let
    // the stream drain normally. Otherwise the consumer walked away early
    // (size cap), so cancel the upload rather than let the client keep pushing
    // bytes we have already refused.
    if (completed) {
      reader.releaseLock();
    } else {
      await reader.cancel().catch(() => {});
    }
  }
}
