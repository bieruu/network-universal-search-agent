import test from "node:test";
import assert from "node:assert/strict";

import type { ResetMessage } from "./reset-email.ts";
import {
  createResetPasswordSender,
  describeResetDeliveryMode,
  resetEmailHtml,
  resetEmailText,
} from "./reset-email.ts";

const KEY = { RESEND_API_KEY: "re_test_key", AUTH_FROM_EMAIL: "Universal Search <noreply@x.test>" };
const ARGS = { user: { email: "known@example.com" }, url: "http://localhost:3000/reset-password/tok?callbackURL=%2Freset-password" };

function collector() {
  const sent: ResetMessage[] = [];
  const warnings: string[] = [];
  return {
    sent,
    warnings,
    deps: {
      send: async (args: ResetMessage) => {
        sent.push(args);
      },
      warn: (message: string) => warnings.push(message),
    },
  };
}

/* ---------------------------- no enumeration ----------------------------- */

test("sender returns nothing at all whatever the address", async () => {
  const known = collector();
  const unknown = collector();
  const sendKnown = createResetPasswordSender(KEY, known.deps);
  const sendUnknown = createResetPasswordSender(KEY, unknown.deps);

  // Better Auth's contract is `Promise<void>` on purpose: there is no channel
  // through which "this account exists" could travel back to the caller.
  const results = await Promise.all([
    sendKnown(ARGS),
    sendUnknown({ user: { email: "nobody@example.com" }, url: ARGS.url }),
  ]);
  for (const result of results) assert.equal(result, undefined);
  assert.equal(known.warnings.length, 0);
  assert.equal(unknown.warnings.length, 0);
});

test("the sender never throws, so a known address cannot be told from an unknown one", async () => {
  // Better Auth awaits this callback and turns a throw into a 500. Since an
  // unknown address short-circuits BEFORE this runs, throwing here would be a
  // perfect "this account exists" oracle. Neither branch may throw.
  const { deps } = collector();
  const send = createResetPasswordSender(KEY, deps);
  await assert.doesNotReject(send(ARGS));
  await assert.doesNotReject(send({ user: { email: "ghost@example.com" }, url: ARGS.url }));
});

test("a provider failure is swallowed, not rethrown", async () => {
  const warnings: string[] = [];
  const send = createResetPasswordSender(KEY, {
    send: async () => {
      throw new Error("Resend 401: invalid api key re_12345");
    },
    warn: (m) => warnings.push(m),
  });

  await assert.doesNotReject(send(ARGS));
  assert.equal(warnings.length, 1);
  // The warning must not carry the address or the provider's error text.
  assert.ok(!warnings[0].includes("known@example.com"), "no address in the warning");
  assert.ok(!warnings[0].includes("re_12345"), "no provider error text in the warning");
  assert.ok(!warnings[0].includes("401"), "no status detail in the warning");
});

/* ------------------------------ fail closed ------------------------------ */

test("with no API key nothing is sent and the operator is warned once", async () => {
  const { sent, warnings, deps } = collector();
  const send = createResetPasswordSender({}, deps);

  await send(ARGS);
  await send(ARGS);
  await send(ARGS);

  assert.equal(sent.length, 0, "must not pretend to send");
  assert.equal(warnings.length, 1, "warn once per process, not per request");
  assert.match(warnings[0], /RESEND_API_KEY/);
  assert.match(warnings[0], /NOT be sent/i);
  // A blank value counts as unset.
});

test("a blank API key is treated as unset", () => {
  assert.match(describeResetDeliveryMode({ RESEND_API_KEY: "   " }) ?? "", /RESEND_API_KEY/);
  assert.equal(describeResetDeliveryMode(KEY), null);
});

test("a configured sender does not warn about the missing key", async () => {
  const { sent, warnings, deps } = collector();
  const send = createResetPasswordSender(KEY, deps);
  await send(ARGS);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "known@example.com");
  assert.equal(warnings.length, 0);
});

test("the reset link is the one Better Auth handed us", async () => {
  const { sent, deps } = collector();
  await createResetPasswordSender(KEY, deps)(ARGS);
  assert.ok(sent[0].html.includes(ARGS.url), "html must carry the reset url");
  assert.ok(sent[0].text.includes(ARGS.url), "plain-text part must carry the reset url");
});

/* ------------------------------- escaping -------------------------------- */

test("the reset URL is HTML-escaped", () => {
  const html = resetEmailHtml("http://x/reset?a=1&b=<script>alert(1)</script>");
  assert.ok(!html.includes("<script>"), "raw markup must not survive");
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("&amp;"), "an unescaped & is enough to break the markup");
});

test("the email says the link is single-use and how long it lasts", () => {
  const text = resetEmailText(ARGS.url);
  assert.match(text, /once/i);
  assert.match(text, /hour/i);
  assert.match(text, /ignore this email/i, "must say what happens if it was not them");
});

test("the from address falls back without crashing", async () => {
  const { sent, deps } = collector();
  await createResetPasswordSender({ RESEND_API_KEY: "k" }, deps)(ARGS);
  // The sender owns `from`; auth.ts supplies it. This asserts the module does
  // not require AUTH_FROM_EMAIL to exist.
  assert.equal(sent.length, 1);
});