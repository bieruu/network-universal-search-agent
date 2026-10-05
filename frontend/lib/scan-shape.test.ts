import test from "node:test";
import assert from "node:assert/strict";
import { getCveEvidence, getSubdomains, getSubdomainCount } from "./scan-shape.ts";

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

test("CVE evidence merges Shodan and NVD ids", () => {
  const ev = getCveEvidence({
    shodan: { vulns: ["CVE-2025-1"] },
    nvd: { status: "found", cves: [{ id: "CVE-2021-41773" }, { id: "CVE-2025-1" }] },
  });
  assert.deepEqual(ev.ids, ["CVE-2025-1", "CVE-2021-41773"]);
  assert.equal(ev.count, 2);
  assert.equal(ev.status, "found");
});

test("CVE unavailable without ids is not zero", () => {
  const ev = getCveEvidence({ shodan: {}, nvd: { status: "unavailable", cves: [] } });
  assert.equal(ev.count, null);
  assert.equal(ev.status, "unavailable");
});

test("CVE insufficient evidence without ids is not zero", () => {
  const ev = getCveEvidence({ nvd: { status: "insufficient_evidence", cves: [] } });
  assert.equal(ev.count, null);
});

test("CVE no_match keeps source ids and stays numeric", () => {
  const ev = getCveEvidence({
    shodan: { vulns: ["CVE-2025-1"] },
    nvd: { status: "no_match", cves: [] },
  });
  assert.equal(ev.count, 1);
  assert.equal(ev.status, "no_match");
});

test("CVE rejected rows are excluded from scored evidence", () => {
  const ev = getCveEvidence({
    shodan: { vulns: ["CVE-2020-0001", "CVE-2021-41773"] },
    nvd: {
      status: "found",
      cves: [],
      cve_rows: [
        { id: "CVE-2020-0001", tier: "rejected" },
        { id: "CVE-2021-41773", tier: "verified" },
      ],
    },
  });
  assert.deepEqual(ev.ids, ["CVE-2021-41773"]);
  assert.equal(ev.count, 1);
});