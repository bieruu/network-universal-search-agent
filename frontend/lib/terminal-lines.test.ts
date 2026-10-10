import test from "node:test";
import assert from "node:assert/strict";
import { terminalLinesFromScan } from "../app/_components/landing/terminal-lines.ts";
import type { ScanResult } from "./api.ts";

function scan(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    scan_id: "s1",
    target: "acme-corp-internal.co.uk",
    status: "completed",
    risk_score: 42,
    results: {
      shodan: { ports: [22, 443, 8080], services: [{ port: 443, product: "nginx", version: "1.25.3" }] },
      crtsh: { subdomains: [{ subdomain: "api.example.co.uk", issuer: "letsencrypt" }] },
      whois: { registrar: "namecheap", name_servers: ["ns1.example.com"] },
    },
    errors: [],
    ...overrides,
  };
}

test("returns exactly four lines with a masked command", () => {
  const s = terminalLinesFromScan(scan());
  assert.ok(s);
  assert.equal(s.output.length, 4);
  assert.equal(s.command, "scan a***.co.uk");
});

test("privacy: the identifying target never reaches the output", () => {
  const s = terminalLinesFromScan(scan({ target: "192.0.2.10" }));
  assert.ok(s);
  assert.equal(s.command, "scan 192.0.2.*");
  assert.ok(!JSON.stringify(s).includes("192.0.2.10"));
});

test("privacy: a bare hostname is fully masked", () => {
  const s = terminalLinesFromScan(scan({ target: "intranet" }));
  assert.ok(s);
  assert.equal(s.command, "scan ***");
  assert.ok(!JSON.stringify(s).includes("intranet"));
});

test("counts and pluralisation read correctly for one and many", () => {
  const one = terminalLinesFromScan(
    scan({
      results: {
        shodan: { ports: [443] },
        crtsh: { subdomains: [{ subdomain: "a.example.co.uk" }] },
        whois: { name_servers: ["ns1.example.com"] },
      },
    }),
  );
  assert.ok(one);
  assert.match(one.output[0], /1 open port\b/);
  assert.match(one.output[1], /1 certificate name\b/);
  assert.match(one.output[2], /1 nameserver\b/);
});

test("missing sections become honest gaps, not blanks or throws", () => {
  const s = terminalLinesFromScan(
    scan({ risk_score: null, results: { shodan: { ports: [22] } } }),
  );
  assert.ok(s);
  assert.match(s.output[1], /no certificate names found/);
  assert.match(s.output[2], /no public registration details/);
  assert.match(s.output[3], /not scored/);
});

test("malformed and empty scans fall back to the static samples", () => {
  assert.equal(terminalLinesFromScan(scan({ results: {}, risk_score: null })), null);
  assert.equal(terminalLinesFromScan(scan({ target: "   " })), null);
  assert.equal(terminalLinesFromScan(null as unknown as ScanResult), null);
  assert.equal(terminalLinesFromScan({ target: "x.com" } as ScanResult), null);
});

test("a still-running scan with no data yet is not shown", () => {
  assert.equal(terminalLinesFromScan(scan({ status: "running", results: {}, risk_score: null })), null);
});

test("a partially answered scan still renders, and says so", () => {
  const s = terminalLinesFromScan(
    scan({ status: "partial", results: { shodan: { ports: [22] } } }),
  );
  assert.ok(s);
  assert.match(s.output[3], /42 of 100 · partly answered/);
});

test("no exposed internals leak into terminal copy", () => {
  const s = terminalLinesFromScan(scan());
  assert.ok(s);
  for (const banned of ["heuristic", "immutable", "middleware", "/api/"]) {
    assert.ok(!JSON.stringify(s).includes(banned), `leaked: ${banned}`);
  }
});