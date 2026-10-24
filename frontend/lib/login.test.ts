import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  join(here, "..", "app", "(auth)", "sign-in", "_components", "sign-in-form.tsx"),
  "utf8",
);
const shell = readFileSync(join(here, "..", "app", "(auth)", "_components", "auth-shell.tsx"), "utf8");

// DESIGN.md mandates Phosphor-only for this project's icons ("No emojis in UI -
// Phosphor only"), and the sign-in form is one of the nine files that used to
// carry lucide alongside it. Two icon families in one tree is both a visual tell
// and a written-rule violation, so the contract now names the winner.
test("login uses Phosphor icons only, no CDN or remote images", () => {
  assert.ok(!src.includes("cdn.21st.dev"), "no 21st.dev CDN");
  assert.ok(!src.includes("next/image"), "no next/image remote");
  assert.ok(!src.includes("https://"), "no remote URLs");
  assert.ok(src.includes("@phosphor-icons/react"), "Phosphor icons required");
  assert.ok(!src.includes("lucide-react"), "lucide-react is the family this project is leaving");
});

test("login has no debug logs, and the forgot-password link is live", () => {
  assert.ok(!src.includes("console.log"), "no console.log");
  // This used to assert the absence of "Forgot password": there was no reset
  // flow, so the link would have been dead. The route now exists
  // (app/(auth)/forgot-password/page.tsx), so the guard is inverted - a link
  // must be present AND the page it points at must exist on disk.
  assert.ok(src.includes("Forgot password?"), "forgot-password link required");
  assert.ok(
    readFileSync(join(here, "..", "app", "(auth)", "forgot-password", "page.tsx"), "utf8").includes(
      "ForgotPasswordForm",
    ),
    "the linked route must exist",
  );
});

test("login accent uses the global token, no hardcoded hex", () => {
  assert.ok(shell.includes("bg-accent") || shell.includes("text-accent"), "global accent token required");
  assert.ok(!shell.includes("00E59B") && !shell.includes("00e59b"), "no hardcoded emerald hex - use bg-accent/text-accent/border-accent");
  for (const banned of ["#3b82f6", "#5046e6", "from-blue", "to-purple", "via-purple"]) {
    assert.ok(!shell.includes(banned), `banned accent: ${banned}`);
  }
});

test("login motion is transform/opacity with reduced-motion fallback", () => {
  assert.ok(shell.includes("useReducedMotion"), "reduced-motion fallback required");
  // Hydration (2026-10-14): `useReducedMotion()` answers null on the server but
  // true on a reduce client at first render, so a pre-mount branch on it
  // mismatches the server HTML. The shell gates both of its branches - the
  // local Reveal and the two decorative spans - behind `mounted`.
  assert.ok(shell.includes("const [mounted, setMounted] = useState(false)"), "the shell gates on mount, not on first render");
  assert.ok(shell.includes("if (!mounted || reduce) return <div>"), "Reveal must render the same tree on server and pre-mount client");
  assert.ok(shell.includes("mounted && !reduce"), "the decorative spans must stay absent until mount");
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
