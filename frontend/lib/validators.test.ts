import test from "node:test";
import assert from "node:assert/strict";
import { targetSchema, scanRequestSchema } from "./validators.ts";

test("accepts valid domains", () => {
  for (const d of ["example.com", "sub.example.co.id", "a-b.example.org"]) {
    assert.equal(targetSchema.safeParse(d).success, true, d);
  }
});

test("accepts valid public IPs", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1"]) {
    assert.equal(targetSchema.safeParse(ip).success, true, ip);
  }
});

test("rejects malformed input", () => {
  for (const bad of ["", "not a domain", "http://example.com", "example", "999.999.999.999"]) {
    assert.equal(targetSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

test("rejects overlong target", () => {
  assert.equal(targetSchema.safeParse(`${"a".repeat(250)}.com`).success, false);
});

test("blocks localhost and private ranges", () => {
  const blockedIPs = [
    "127.0.0.1",
    "10.0.0.5",
    "192.168.1.1",
    "172.16.0.1",
    "172.31.255.255",
    "169.254.1.1",
    "0.0.0.0",
  ];
  for (const t of blockedIPs) {
    const r = targetSchema.safeParse(t);
    assert.equal(r.success, false, t);
    if (!r.success) {
      assert.match(r.error.issues[0].message, /blocked/i);
    }
  }
  // "localhost" has no dot so it fails the format check first — still rejected.
  assert.equal(targetSchema.safeParse("localhost").success, false);
});

test("allows 172.32.x (outside private 172.16/12)", () => {
  assert.equal(targetSchema.safeParse("172.32.0.1").success, true);
});

test("scanRequestSchema defaults force to false", () => {
  const r = scanRequestSchema.safeParse({ target: "example.com" });
  assert.equal(r.success, true);
  if (r.success) assert.equal(r.data.force, false);
});

test("scanRequestSchema rejects blocked target", () => {
  assert.equal(scanRequestSchema.safeParse({ target: "localhost" }).success, false);
});
