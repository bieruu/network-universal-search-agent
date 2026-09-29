// Better Auth client stub. Replace with real `better-auth/react` client when wired.
export const authClient = {
  async signInEmail(_email: string, _password: string): Promise<{ ok: boolean }> {
    // TODO: wire to Better Auth: import { createAuthClient } from "better-auth/react"
    return { ok: true };
  },
  async signInOAuth(_provider: "github" | "google"): Promise<{ ok: boolean }> {
    return { ok: true };
  },
  async signOut(): Promise<void> {},
  useSession() {
    return { data: null as { user?: { email?: string } } | null, isPending: false };
  },
};
