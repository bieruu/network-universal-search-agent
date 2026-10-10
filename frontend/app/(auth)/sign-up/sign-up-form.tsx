"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Code2, Globe } from "lucide-react";
import { z } from "zod";
import { AuthShell } from "@/app/(auth)/_components/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { describeSignInError, describeSignUpError } from "@/lib/auth-errors";
import { SIGNUP_RESTRICTED_BODY } from "@/lib/signup-gate";

// Every `.max()` carries its own message: without one Zod emits its default
// template verbatim ("String must contain at most 100 character(s)"), which is
// developer text landing on a sign-up form.
const signUpSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Enter your name")
    .max(100, "Name must be 100 characters or fewer"),
  email: z.string().trim().email("Enter a valid email address"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128, "Password must be 128 characters or fewer"),
  confirmPassword: z.string(),
}).refine((value) => value.password === value.confirmPassword, {
  path: ["confirmPassword"],
  message: "Passwords do not match",
});

const PASSWORD_HELP = "Use 8 to 128 characters. A long passphrase is harder to guess than a short complicated word.";

export default function SignUpForm({ restricted = false }: { restricted?: boolean }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [errorField, setErrorField] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (errorField) errorRef.current?.focus();
  }, [errorField]);

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
        setErrorField(describeSignUpError(result.error));
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
      if (result.error) setErrorField(describeSignInError(result.error));
    } catch {
      setErrorField(
        "We could not complete that sign-in. Try again, or create an account with an email address.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthShell title="Create account" description="Search a domain or IP address for exposed services and known vulnerabilities.">
      {restricted && (
        <p className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
          {SIGNUP_RESTRICTED_BODY}
        </p>
      )}
      <form onSubmit={handleSignUp} className="mt-6 flex flex-col gap-2" aria-busy={pending}>
        <div className="flex flex-col gap-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" autoComplete="name" placeholder="Alex Rivera" value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" autoComplete="email" placeholder="name@company.com" value={email} onChange={(event) => setEmail(event.target.value)} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            placeholder="Minimum 8 characters"
            aria-describedby="sign-up-password-help"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <p id="sign-up-password-help" className="text-xs text-slate-500 dark:text-neutral-500">
            {PASSWORD_HELP}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="confirm-password">Confirm password</Label>
          <Input
            id="confirm-password"
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            placeholder="Type it again"
            aria-describedby="sign-up-password-help"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
          />
        </div>
        {errorField && (
          <p
            id="sign-up-error"
            role="alert"
            tabIndex={-1}
            ref={errorRef}
            className="text-xs text-red-600 dark:text-red-400"
          >
            {errorField}
          </p>
        )}
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
      <p className="mt-2 text-center text-xs text-slate-500 dark:text-neutral-500">
        <Link className="hover:text-accent hover:underline" href="/forgot-password">
          Forgot your password?
        </Link>
      </p>
    </AuthShell>
  );
}