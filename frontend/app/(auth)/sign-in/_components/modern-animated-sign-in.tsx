"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Code2, Globe, Search } from "lucide-react";
import { AuthShell } from "@/app/(auth)/_components/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

export default function ModernAnimatedSignIn() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errorField, setErrorField] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

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
        setErrorField(result.error.message ?? "Sign-in failed");
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
      if (result.error) setErrorField(result.error.message ?? `${provider} sign-in failed`);
    } catch {
      setErrorField(`${provider} sign-in is unavailable. Check provider configuration.`);
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthShell title="Sign in" description="Passive OSINT console for security analysts.">
      <form onSubmit={handleEmailSignIn} className="mt-6 flex flex-col gap-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" autoComplete="email" placeholder="analyst@example.com" value={email} onChange={(event) => setEmail(event.target.value)} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="password">Password</Label>
          <Input id="password" type="password" autoComplete="current-password" placeholder="Minimum 8 characters" value={password} onChange={(event) => setPassword(event.target.value)} />
        </div>
        {errorField && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{errorField}</p>}
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
      <div className="mt-4 flex items-center gap-2 text-xs text-slate-500 dark:text-neutral-500">
        <Search size={14} aria-hidden="true" />
        <span className="font-mono">Session-gated scans. No active probing in v1.</span>
      </div>
      <p className="mt-5 text-center text-sm text-slate-600 dark:text-neutral-400">
        Don&apos;t have an account? <Link className="font-medium text-accent hover:underline" href="/sign-up">Sign up</Link>
      </p>
    </AuthShell>
  );
}
