const SESSION_COOKIE_NAME = "better-auth.session_token";
const SESSION_TTL_MS = 86_400_000;
const DEFAULT_SECRET = "dev-secret-min-32-chars-change-me-xxxx";

function resolveSecret(): string | null {
  const secret = process.env.NEXT_PUBLIC_BETTER_AUTH_SECRET ?? process.env.BETTER_AUTH_SECRET ?? "";
  if (!secret || secret === DEFAULT_SECRET || secret.length < 32) {
    return null;
  }
  return secret;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  const encoded = btoa(binary);
  return encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(normalized);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.split(/;\s*/).find((entry) => entry.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

async function createSignedSessionToken(userId: string, secret: string): Promise<string> {
  const payload = JSON.stringify({ sub: userId, exp: Math.floor((Date.now() + SESSION_TTL_MS) / 1000) });
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  const digest = Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${toBase64Url(enc.encode(payload))}.${digest}`;
}

function readSignedSession(rawToken: string): { user: string } | null {
  if (!rawToken || !rawToken.includes(".")) return null;
  const [payloadB64] = rawToken.split(".");
  if (!payloadB64) return null;

  try {
    const payloadBytes = fromBase64Url(payloadB64);
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes));
    if (typeof payload?.sub !== "string" || !payload.sub.trim()) return null;
    if (typeof payload?.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return { user: payload.sub.trim() };
  } catch {
    return null;
  }
}

async function setSignedSessionCookie(userId: string): Promise<void> {
  const secret = resolveSecret();
  if (!secret) {
    return;
  }
  const value = await createSignedSessionToken(userId, secret);
  document.cookie = `${SESSION_COOKIE_NAME}=${value}; path=/; max-age=86400; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
}

export const authClient = {
  async signInEmail(email: string, _password: string): Promise<{ ok: boolean }> {
    if (!resolveSecret()) {
      return { ok: false };
    }
    if (typeof document !== "undefined") {
      await setSignedSessionCookie(email || "user@local.test");
    }
    return { ok: true };
  },
  async signInOAuth(provider: "github" | "google"): Promise<{ ok: boolean }> {
    if (!resolveSecret()) {
      return { ok: false };
    }
    if (typeof document !== "undefined") {
      await setSignedSessionCookie(`${provider}@local.test`);
    }
    return { ok: true };
  },
  async signOut(): Promise<void> {
    if (typeof document !== "undefined") {
      for (const name of [SESSION_COOKIE_NAME, "__Secure-better-auth.session_token"]) {
        document.cookie = `${name}=; path=/; max-age=0; SameSite=Lax`;
      }
    }
  },
  useSession() {
    if (typeof document === "undefined") {
      return { data: null, isPending: false };
    }
    const raw = readCookie(SESSION_COOKIE_NAME) ?? readCookie("__Secure-better-auth.session_token");
    if (!raw) {
      return { data: null, isPending: false };
    }
    const session = readSignedSession(raw);
    return { data: session ? { user: { email: session.user } } : null, isPending: false };
  },
};
