// Better Auth client stub. Replace with real `better-auth/react` client when wired.
export const authClient = {
  async signInEmail(_email: string, _password: string): Promise<{ ok: boolean }> {
    // TODO: wire to Better Auth: import { createAuthClient } from "better-auth/react"
    if (typeof document !== "undefined") {
      document.cookie = "better-auth.session_token=dev-session; path=/; max-age=86400; SameSite=Lax";
    }
    return { ok: true };
  },
  async signInOAuth(_provider: "github" | "google"): Promise<{ ok: boolean }> {
    if (typeof document !== "undefined") {
      document.cookie = "better-auth.session_token=dev-oauth; path=/; max-age=86400; SameSite=Lax";
    }
    return { ok: true };
  },
  async signOut(): Promise<void> {
    if (typeof document !== "undefined") {
      for (const name of ["better-auth.session_token", "__Secure-better-auth.session_token"]) {
        document.cookie = `${name}=; path=/; max-age=0; SameSite=Lax`;
      }
    }
  },
  useSession() {
    return { data: null as { user?: { email?: string } } | null, isPending: false };
  },
};
