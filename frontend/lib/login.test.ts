import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  join(here, "..", "app", "(auth)", "sign-in", "_components", "modern-animated-sign-in.tsx"),
  "utf8",
);
const shell = readFileSync(join(here, "..", "app", "(auth)", "_components", "auth-shell.tsx"), "utf8");

test("login uses lucide icons only, no CDN or remote images", () => {
  assert.ok(!src.includes("cdn.21st.dev"), "no 21st.dev CDN");
  assert.ok(!src.includes("next/image"), "no next/image remote");
  assert.ok(!src.includes("https://"), "no remote URLs");
  assert.ok(src.includes("lucide-react"), "lucide icons required");
});

test("login has no debug logs or dead routes", () => {
  assert.ok(!src.includes("console.log"), "no console.log");
  assert.ok(!src.includes("Forgot password"), "no dead forgot-password route");
});

test("login accent uses the global token, no hardcoded hex", () => {
  assert.ok(shell.includes("bg-accent") || shell.includes("text-accent"), "global accent token required");
  assert.ok(!shell.includes("00E59B") && !shell.includes("00e59b"), "no hardcoded emerald hex — use bg-accent/text-accent/border-accent");
  for (const banned of ["#3b82f6", "#5046e6", "from-blue", "to-purple", "via-purple"]) {
    assert.ok(!shell.includes(banned), `banned accent: ${banned}`);
  }
});

test("login motion is transform/opacity with reduced-motion fallback", () => {
  assert.ok(shell.includes("useReducedMotion"), "reduced-motion fallback required");
  assert.ok(shell.includes("motion-safe:animate-ambient"), "login ambient must be motion-safe CSS only");
  assert.ok(!shell.includes("addEventListener"), "no manual listeners");
});

test("login wires authClient and surfaces field errors", () => {
  assert.ok(src.includes("authClient.signIn.email"), "Better Auth email API required");
  assert.ok(src.includes("authClient.signIn.social"), "Better Auth social API required");
  assert.ok(src.includes('router.push("/dashboard")'), "redirect required");
  assert.ok(src.includes("errorField"), "errorField required");
  assert.ok(src.includes('role="alert"'), "alert region required");
});

test("login links to the separate account creation flow", () => {
  assert.ok(src.includes('href="/sign-up"'), "sign-up link required");
  assert.ok(src.includes("Continue with GitHub"), "GitHub OAuth entry point required");
});

test("login primary CTA uses the accent variant (no bg cascade conflict)", () => {
  assert.ok(src.includes('variant="accent"'), "accent variant required for emerald CTA");
  const button = readFileSync(
    join(here, "..", "components", "ui", "button.tsx"),
    "utf8",
  );
  assert.ok(button.includes('"accent"'), "Button must support the accent variant");
});
test("login form follows label-top error-bottom convention", () => {
  assert.ok(src.includes("<Label"), "Label required");
  assert.ok(src.includes("<Input"), "Input required");
  assert.ok(src.includes("gap-2"), "gap-2 required");
});
