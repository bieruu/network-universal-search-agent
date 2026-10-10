"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { z } from "zod";
import { AuthShell } from "@/app/(auth)/_components/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { describeResetError } from "@/lib/auth-errors";
import { setResetConfirmation } from "@/lib/reset-confirmation";

const passwordSchema = z.object({
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128, "Password must be 128 characters or fewer"),
  confirmPassword: z.string(),
}).refine((value) => value.password === value.confirmPassword, {
  path: ["confirmPassword"],
  message: "The two passwords do not match",
});

const PASSWORD_HELP = "Use 8 to 128 characters. A long passphrase is harder to guess than a short complicated word.";

export function ResetPasswordForm({ token, error }: { token?: string; error?: string }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [errorField, setErrorField] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);

  // A link that arrives already rejected (no token, or `?error=INVALID_TOKEN`
  // from Better Auth's callback route) is shown before any interaction.
  const deadLinkReason = !token
    ? "This page needs a reset link. Open the link from your email, or request a new one below."
    : error
      ? describeResetError(error)
      : null;

  useEffect(() => {
    if (errorField) errorRef.current?.focus();
  }, [errorField]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorField(null);
    if (!token) return;

    const input = passwordSchema.safeParse({ password, confirmPassword });
    if (!input.success) {
      setErrorField(input.error.issues[0]?.message ?? "Check the form and try again");
      return;
    }

    setPending(true);
    try {
      const result = await authClient.resetPassword({
        newPassword: input.data.password,
        token,
      });
      if (result.error) {
        setErrorField(describeResetError(result.error));
        return;
      }
      setResetConfirmation();
      router.push("/sign-in");
      router.refresh();
    } catch {
      setErrorField(
        "We could not reset that password. Request a new link and try again.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthShell
      title="Set a new password"
      description="Choose a new password for your account. You will sign in with it straight away."
    >
      <form
        onSubmit={handleSubmit}
        className="mt-6 flex flex-col gap-2"
        aria-busy={pending}
        // A dead link leaves no way to submit: the button is disabled and the
        // only route forward is the link back to /forgot-password below.
        hidden={Boolean(deadLinkReason)}
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor="new-password">New password</Label>
          <Input
            id="new-password"
            name="newPassword"
            type="password"
            autoComplete="new-password"
            placeholder="Minimum 8 characters"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-describedby="new-password-help"
          />
          <p id="new-password-help" className="text-xs text-slate-500 dark:text-neutral-500">
            {PASSWORD_HELP}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="confirm-password">Confirm new password</Label>
          <Input
            id="confirm-password"
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            placeholder="Type it again"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            aria-describedby="new-password-help"
          />
        </div>
        {errorField && (
          <p
            id="reset-password-error"
            role="alert"
            tabIndex={-1}
            ref={errorRef}
            className="text-xs text-red-600 dark:text-red-400"
          >
            {errorField}
          </p>
        )}
        <Button type="submit" variant="accent" disabled={pending} className="mt-2 w-full rounded-full">
          {pending ? "Saving…" : "Set new password"}
        </Button>
      </form>

      {deadLinkReason && (
        <p
          role="alert"
          tabIndex={-1}
          ref={errorRef}
          className="mt-6 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200"
        >
          {deadLinkReason}
        </p>
      )}

      <p className="mt-5 text-center text-sm text-slate-600 dark:text-neutral-400">
        <Link className="font-medium text-accent hover:underline" href="/forgot-password">
          Request a new reset link
        </Link>
      </p>
      <p className="mt-2 text-center text-sm">
        <Link className="text-xs text-slate-500 underline-offset-2 hover:text-accent hover:underline dark:text-neutral-500" href="/sign-in">
          Back to sign in
        </Link>
      </p>
    </AuthShell>
  );
}