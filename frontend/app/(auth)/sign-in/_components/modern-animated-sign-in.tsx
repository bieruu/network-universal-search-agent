"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Code2, Globe } from "lucide-react";
import { AuthShell } from "@/app/(auth)/_components/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { describeSignInError } from "@/lib/auth-errors";
import { takeResetConfirmation, RESET_DONE_MESSAGE } from "@/lib/reset-confirmation";

export default function ModernAnimatedSignIn() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errorField, setErrorField] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  // Set by /reset-password immediately before it redirects here. Read once, on
  // mount, so the confirmation does not come back on every later visit.
  const [justReset, setJustReset] = useState(false);
  const confirmationRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (!takeResetConfirmation()) return;
    setJustReset(true);
    confirmationRef.current?.focus();
  }, []);

  // The error paragraph only exists after a render, so focus cannot be moved
  // from inside the submit handler — this effect runs once it is mounted.
  useEffect(() => {
    if (errorField) errorRef.current?.focus();
  }, [errorField]);

  async function handleEmailSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorField(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setErrorField("Enter a valid email address");
      return;
    }
    if (password.length < 8) {
      setErrorField("Password must be at least 8 characters");
      return;
    }

    setPending(true);
    try {
      const result = await authClient.signIn.email({
        email,
        password,
        callbackURL: "/dashboard",
      });
      if (result.error) {
        setErrorField(describeSignInError(result.error));
        return;
      }
      router.push("/dashboard");
      router.refresh();
    } catch {
      setErrorField("Sign-in request failed. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  async function handleOAuth(provider: "google" | "github") {
    setErrorField(null);
    setPending(true);
    try {
      const result = await authClient.signIn.social({ provider, callbackURL: "/dashboard" });
      // Mapped, not rendered: this branch is where the provider's raw error
      // text (INVALID_PROVIDER, STATE_MISMATCH, ...) used to reach the page.
      if (result.error) setErrorField(describeSignInError(result.error));
    } catch {
      setErrorField(
        "We could not complete that sign-in. Try again, or sign in with your email and password.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthShell
      title="Sign in"
      description="Search a domain or IP address for exposed services and known vulnerabilities."
    >
      {justReset && (
        <p
          role="status"
          tabIndex={-1}
          ref={confirmationRef}
          className="mt-6 rounded-2xl border border-accent/40 bg-accent/5 p-3 text-sm text-slate-700 dark:text-neutral-200"
        >
          {RESET_DONE_MESSAGE}
        </p>
      )}
      <form
        onSubmit={handleEmailSignIn}
        className={justReset ? "mt-4 flex flex-col gap-2" : "mt-6 flex flex-col gap-2"}
        aria-busy={pending}
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" autoComplete="email" placeholder="name@company.com" value={email} onChange={(event) => setEmail(event.target.value)} />
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="password">Password</Label>
            <Link
              className="text-xs font-medium text-accent hover:underline"
              href="/forgot-password"
            >
              Forgot password?
            </Link>
          </div>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            placeholder="Minimum 8 characters"
            aria-describedby={errorField ? "sign-in-error" : undefined}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        {errorField && (
          <p
            id="sign-in-error"
            role="alert"
            tabIndex={-1}
            ref={errorRef}
            className="text-xs text-red-600 dark:text-red-400"
          >
            {errorField}
          </p>
        )}
        <Button type="submit" variant="accent" disabled={pending} className="mt-2 w-full rounded-full">
          {pending ? "Signing in…" : "Sign in with email"}
        </Button>
      </form>
      <div className="mt-3 grid gap-2">
        <Button type="button" variant="outline" onClick={() => handleOAuth("google")} disabled={pending} className="w-full rounded-full">
          <Globe size={18} strokeWidth={2} className="mr-2" aria-hidden="true" />
          Continue with Google
        </Button>
        <Button type="button" variant="outline" onClick={() => handleOAuth("github")} disabled={pending} className="w-full rounded-full">
          <Code2 size={18} strokeWidth={2} className="mr-2" aria-hidden="true" />
          Continue with GitHub
        </Button>
      </div>
      <p className="mt-5 text-center text-sm text-slate-600 dark:text-neutral-400">
        Don&apos;t have an account? <Link className="font-medium text-accent hover:underline" href="/sign-up">Sign up</Link>
      </p>
    </AuthShell>
  );
}