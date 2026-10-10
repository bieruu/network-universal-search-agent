"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { z } from "zod";
import { AuthShell } from "@/app/(auth)/_components/auth-shell";
import { Button, buttonClasses } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { RESET_REQUEST_SENT } from "@/lib/auth-errors";

const emailSchema = z
  .string()
  .trim()
  .min(1, "Enter the email address on your account")
  .email("Enter a valid email address");

/**
 * The confirmation is deliberately NOT conditional on anything.
 *
 * Better Auth answers `request-password-reset` with the same body for a known
 * and an unknown address and burns equivalent work in both branches, but this
 * page must not become the layer that reintroduces the difference: no
 * "we found your account", no different copy on failure, no redirect. One
 * message, always. The only field here that varies with the outcome is
 * `pending` — and it settles before the message renders in every branch.
 */
export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [errorField, setErrorField] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);
  const statusRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (sent || errorField) statusRef.current?.focus();
  }, [sent, errorField]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sent) return;
    setErrorField(null);

    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) {
      setErrorField(parsed.error.issues[0]?.message ?? "Enter a valid email address");
      return;
    }

    setPending(true);
    try {
      const result = await authClient.requestPasswordReset({
        email: parsed.data,
        // Where Better Auth sends the browser once the emailed token validates.
        redirectTo: "/reset-password",
      });
      if (result.error) {
        // Same confirmation even here. The one thing a caller must not learn
        // from this form is whether the address has an account.
        console.warn("Password reset request was rejected by the auth server.");
        setSent(true);
        return;
      }
      setSent(true);
    } catch {
      console.warn("Password reset request failed in transit.");
      setSent(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthShell
      title="Reset your password"
      description="Enter the email address on your account and we will send you a link to set a new password."
    >
      {sent ? (
        <div className="mt-6 flex flex-col gap-4">
          <p
            role="status"
            tabIndex={-1}
            ref={statusRef}
            className="rounded-2xl border border-accent/40 bg-accent/5 p-4 text-sm text-slate-700 dark:text-neutral-200"
          >
            {RESET_REQUEST_SENT}
          </p>
          <Link href="/sign-in" className={buttonClasses("accent")}>
            Back to sign in
          </Link>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-2" aria-busy={pending}>
          <div className="flex flex-col gap-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              placeholder="name@company.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              aria-describedby={errorField ? "forgot-password-error" : "forgot-password-help"}
              aria-invalid={errorField ? true : undefined}
            />
            <p id="forgot-password-help" className="text-xs text-slate-500 dark:text-neutral-500">
              The link works once and expires after an hour.
            </p>
          </div>
          {errorField && (
            <p
              id="forgot-password-error"
              role="alert"
              className="text-xs text-red-600 dark:text-red-400"
            >
              {errorField}
            </p>
          )}
          <Button type="submit" variant="accent" disabled={pending} className="mt-2 w-full rounded-full">
            {pending ? "Sending…" : "Send reset link"}
          </Button>
        </form>
      )}
      <p className="mt-5 text-center text-sm text-slate-600 dark:text-neutral-400">
        <Link className="font-medium text-accent hover:underline" href="/sign-in">
          Back to sign in
        </Link>
      </p>
      <p className="mt-4 text-center">
        <Link className="text-xs text-slate-500 underline-offset-2 hover:text-accent hover:underline dark:text-neutral-500" href="/reset-password">
          Already have a reset link? Set a new password
        </Link>
      </p>
    </AuthShell>
  );
}

