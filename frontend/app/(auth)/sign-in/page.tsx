"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";

export default function SignInPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  async function emailSignIn(e: React.FormEvent) {
    e.preventDefault();
    const r = await authClient.signInEmail(email, password);
    if (r.ok) router.push("/dashboard");
    else setMsg("Sign-in failed");
  }

  async function oauth(p: "github" | "google") {
    const r = await authClient.signInOAuth(p);
    if (r.ok) router.push("/dashboard");
    else setMsg("OAuth failed");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-6">
      <Card>
        <h1 className="text-lg font-bold">Sign in</h1>
        <p className="text-xs opacity-60">Better Auth — email + OAuth placeholder.</p>
        <form onSubmit={emailSignIn} className="mt-4 flex flex-col gap-2">
          <Input placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="email" />
          <Input
            placeholder="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-label="password"
          />
          <Button type="submit">Sign in with email</Button>
        </form>
        <div className="mt-3 flex gap-2">
          <Button variant="outline" onClick={() => oauth("github")}>
            GitHub
          </Button>
          <Button variant="outline" onClick={() => oauth("google")}>
            Google
          </Button>
        </div>
        {msg && <p className="mt-2 text-xs text-red-400">{msg}</p>}
      </Card>
    </main>
  );
}
