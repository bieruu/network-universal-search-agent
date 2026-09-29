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
  .min(1, "Target is required")
  .max(253, "Target too long")
  .refine((v) => DOMAIN_RE.test(v) || IP_RE.test(v), {
    message: "Enter a valid domain (example.com) or IPv4 address",
  })
  .refine((v) => !isBlockedTarget(v), {
    message: "Private/localhost targets are blocked",
  });

export const scanRequestSchema = z.object({
  target: targetSchema,
  force: z.boolean().optional().default(false),
});

export type ScanRequest = z.infer<typeof scanRequestSchema>;
