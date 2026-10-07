"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Code2, Globe } from "lucide-react";
import { z } from "zod";
import { AuthShell } from "@/app/(auth)/_components/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { SIGNUP_RESTRICTED_BODY } from "@/lib/signup-gate";

const signUpSchema = z.object({
  name: z.string().trim().min(1, "Enter your name").max(100),
  email: z.string().trim().email("Enter a valid email address"),
  password: z.string().min(8, "Password must be at least 8 characters").max(128),
  confirmPassword: z.string(),
}).refine((value) => value.password === value.confirmPassword, {
  path: ["confirmPassword"],
  message: "Passwords do not match",
});

/**
 * Better Auth answers a blocked account creation with a deliberately generic
 * FAILED_TO_CREATE_USER / EMAIL_PASSWORD_SIGN_UP_DISABLED — it will not tell an
 * anonymous caller whether the email is allowlisted or the master switch is
 * off, and neither should we. But "Failed to create user" is useless to a
 * legitimate user who mistyped their address, so map it to actionable copy.
 */
function describeSignUpError(message: string | undefined): string {
  const text = (message ?? "").toLowerCase();
  if (
    text.includes("failed to create user") ||
    text.includes("sign up is not enabled") ||
    text.includes("user already exists")
  ) {
    return "Sign-up is not available for this email address. Ask an administrator for access.";
  }
  return message ?? "Account creation failed";
}

export default function SignUpForm({ restricted = false }: { restricted?: boolean }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [errorField, setErrorField] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSignUp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorField(null);
    const input = signUpSchema.safeParse({ name, email, password, confirmPassword });
    if (!input.success) {
      setErrorField(input.error.issues[0]?.message ?? "Check the form and try again");
      return;
    }

    setPending(true);
    try {
      const result = await authClient.signUp.email({
        name: input.data.name,
        email: input.data.email,
        password: input.data.password,
        callbackURL: "/dashboard",
      });
      if (result.error) {
        setErrorField(describeSignUpError(result.error.message));
        return;
      }
      router.push("/dashboard");
      router.refresh();
    } catch {
      setErrorField("Sign-up request failed. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  async function handleOAuth(provider: "google" | "github") {
    setErrorField(null);
    setPending(true);
    try {
      const result = await authClient.signIn.social({ provider, callbackURL: "/dashboard" });
      if (result.error) setErrorField(result.error.message ?? `${provider} sign-in failed`);
    } catch {
      setErrorField(`${provider} sign-in is unavailable. Check provider configuration.`);
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthShell title="Create account" description="Create an account to start a private OSINT workspace.">
      {restricted && (
        <p className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
          {SIGNUP_RESTRICTED_BODY}
        </p>
      )}
      <form onSubmit={handleSignUp} className="mt-6 flex flex-col gap-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="password">Password</Label>
          <Input id="password" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="confirm-password">Confirm password</Label>
          <Input id="confirm-password" type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
        </div>
        {errorField && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{errorField}</p>}
        <Button type="submit" variant="accent" disabled={pending} className="mt-2 w-full rounded-full">
          {pending ? "Creating account…" : "Create account"}
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
        Already have an account? <Link className="font-medium text-accent hover:underline" href="/sign-in">Sign in</Link>
      </p>
    </AuthShell>
  );
}
