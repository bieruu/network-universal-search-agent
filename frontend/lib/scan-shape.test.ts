import test from "node:test";
import assert from "node:assert/strict";
import { getSubdomains, getSubdomainCount } from "./scan-shape.ts";

// Backend truth: crtsh_service returns { domain, count, subdomains[] }.
const BACKEND_SHAPE = {
  crtsh: {
    domain: "example.com",
    count: 2,
    subdomains: [
      { subdomain: "a.example.com", issuer: "CA" },
      { subdomain: "b.example.com", issuer: "CA" },
    ],
  },
};

test("reads backend dict shape without crashing", () => {
  assert.equal(getSubdomains(BACKEND_SHAPE).length, 2);
  assert.equal(getSubdomainCount(BACKEND_SHAPE), 2);
});

test("falls back to empty on missing/garbage", () => {
  assert.deepEqual(getSubdomains(null), []);
  assert.deepEqual(getSubdomains({}), []);
  assert.deepEqual(getSubdomains({ crtsh: { count: 5 } }), []);
  assert.equal(getSubdomainCount({}), 0);
});

test("prefers count when present, else list length", () => {
  assert.equal(getSubdomainCount({ crtsh: { subdomains: [{ subdomain: "x" }] } }), 1);
});
