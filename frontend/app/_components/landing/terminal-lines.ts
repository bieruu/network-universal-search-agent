/**
 * Builds the landing terminal's four output lines from a real scan result.
 *
 * The terminal has two modes and only ONE shape:
 *   - signed out  -> three static samples, rotated (see TerminalTyper.tsx)
 *   - signed in   -> the ONE most recent scan, shown once
 * Both produce `{ command, output: string[] }`, so TerminalTyper needs no
 * branching on which mode it is in.
 *
 * Everything here is pure and defensive. A scan is third-party data, so every
 * field is read defensively and any missing field simply drops out of its line.
 * Returning `null` (nothing worth showing) is a normal outcome, not an error:
 * the caller falls back to the static samples.
 *
 * PRIVACY: the target is reduced with `maskTarget()` before it can reach any
 * rendered output. A signed-in analyst's targets are often internal client
 * domains and this markup lands in an HTML document a CDN is free to cache.
 * Counts, software names and the risk score are unaffected — only the
 * identifying name is reduced.
 */

// Relative + explicit extensions so this module runs unchanged under
// `node --test lib/terminal-lines.test.ts`, which does not resolve `@/`
// (same reason lib/analysis-api.ts does this).
import type { ScanResult } from "../../../lib/api.ts";
import { maskTarget, plural } from "../../../lib/terms.ts";
import { scanStatusLabel } from "../../../lib/scan-status.ts";

export interface TerminalSample {
  command: string;
  output: string[];
}

/** Column width so the four lines read as one aligned block. */
const LABEL_WIDTH = 8;

function row(label: string, text: string): string {
  return `${label.padEnd(LABEL_WIDTH)}${text}`;
}

/** "apache 2.4.29" from the first service that advertises both fields. */
function topService(scan: ScanResult): string | null {
  const services = scan.results?.shodan?.services;
  if (!Array.isArray(services)) return null;
  for (const s of services) {
    const product = s?.product?.trim();
    const version = s?.version?.trim();
    if (product) return version ? `${product} ${version}` : product;
  }
  return null;
}

function topIssuer(scan: ScanResult): string | null {
  const names = scan.results?.crtsh?.subdomains;
  if (!Array.isArray(names)) return null;
  for (const n of names) {
    const issuer = n?.issuer?.trim();
    if (issuer) return issuer;
  }
  return null;
}

/**
 * Returns the four lines for `scan`, or `null` when the scan has nothing worth
 * putting on a public page (no ports, no names, no domain details, no score).
 */
export function terminalLinesFromScan(scan: ScanResult): TerminalSample | null {
  if (!scan || typeof scan !== "object") return null;

  const target = typeof scan.target === "string" ? scan.target : "";
  if (!target.trim()) return null;

  const ports = scan.results?.shodan?.ports;
  const portCount = Array.isArray(ports) ? ports.length : 0;

  const names = scan.results?.crtsh?.subdomains;
  const nameCount = Array.isArray(names) ? names.length : 0;

  const whois = scan.results?.whois;
  const registrar = typeof whois?.registrar === "string" ? whois.registrar.trim() : "";
  const nameServers = Array.isArray(whois?.name_servers) ? whois.name_servers.length : 0;

  const score = typeof scan.risk_score === "number" ? scan.risk_score : null;

  if (portCount === 0 && nameCount === 0 && !registrar && nameServers === 0 && score === null) {
    return null;
  }

  const output: string[] = [];

  output.push(
    portCount > 0
      ? row(
          "ports",
          `${portCount} open ${plural(portCount, "port", "ports")}${
            topService(scan) ? ` · ${topService(scan)}` : ""
          }`,
        )
      : row("ports", "none seen on the public internet"),
  );

  output.push(
    nameCount > 0
      ? row(
          "certs",
          `${nameCount} certificate ${plural(nameCount, "name", "names")}${
            topIssuer(scan) ? ` · issuer ${topIssuer(scan)}` : ""
          }`,
        )
      : row("certs", "no certificate names found"),
  );

  const domainBits: string[] = [];
  if (registrar) domainBits.push(`registered with ${registrar}`);
  if (nameServers > 0) {
    domainBits.push(`${nameServers} ${plural(nameServers, "nameserver", "nameservers")}`);
  }
  output.push(
    domainBits.length > 0
      ? row("domain", domainBits.join(" · "))
      : row("domain", "no public registration details"),
  );

  output.push(
    score === null
      ? row("risk", "not scored")
      : row("risk", `${score} of 100 · ${scanStatusLabel(scan.status).toLowerCase()}`),
  );

  return { command: `scan ${maskTarget(target)}`, output };
}