import { z } from "zod";

const DOMAIN_RE = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i;
const IP_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;

function isBlockedTarget(v: string): boolean {
  const t = v.toLowerCase().trim();
  if (t === "localhost") return true;
  if (IP_RE.test(t)) {
    const parts = t.split(".").map(Number);
    if (parts.some((n) => n > 255)) return true;
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
  }
  return false;
}

export const targetSchema = z
  .string()
  .trim()
  .min(1, "Enter something to search for — a domain name such as example.com, or an IP address.")
  .max(253, "That is longer than any domain name can be. A domain is at most 253 characters — check for extra text that came along with the paste.")
  .refine((v) => DOMAIN_RE.test(v) || IP_RE.test(v), {
    message: "We could not read that as a web address. Enter a domain name such as example.com, or a public IPv4 address such as 8.8.8.8.",
  })
  .refine((v) => !isBlockedTarget(v), {
    message: "That address is on a private or local network, so it is blocked — the sources we search can only see hosts reachable from the public internet. Enter the target's public address instead.",
  });

export const scanRequestSchema = z.object({
  target: targetSchema,
  force: z.boolean().optional().default(false),
});

export type ScanRequest = z.infer<typeof scanRequestSchema>;
