import type { Metadata } from "next";
import { headers } from "next/headers";
import type { HistoryItem, ScanResult } from "@/lib/api";
import { terminalLinesFromScan, type TerminalSample } from "./_components/landing/terminal-lines";
import AmbientBackdrop from "./_components/landing/AmbientBackdrop";
import CtaFooter from "./_components/landing/CtaFooter";
import FeatureBento from "./_components/landing/FeatureBento";
import Hero from "./_components/landing/Hero";
import HowItWorks from "./_components/landing/HowItWorks";
import LogoStrip from "./_components/landing/LogoStrip";
import Nav from "./_components/landing/Nav";
import ParallaxField from "./_components/landing/ParallaxField";
import SecurityStrip from "./_components/landing/SecurityStrip";
import StackStrip from "./_components/landing/StackStrip";

export const metadata: Metadata = {
  title: "Universal Search — see what a domain exposes",
  description:
    "Search a domain or IP and read its open ports, subdomain names, registration details, and a risk score in one place.",
};

// A signed-in visitor gets their own most recent scan rendered into the HTML
// below, so this render is per-user and must never be stored anywhere shared.
// `dynamic` opts out of static generation and the route's own fetch runs with
// `cache: "no-store"`, which together mean no CDN may retain the response.
export const dynamic = "force-dynamic";
export const revalidate = 0;

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8000";

/**
 * Reads the signed-in user's most recent scan, or `null` for "show the
 * samples".
 *
 * The fallback is structural, not a catch-all guess: every step returns `null`
 * on failure and the page renders the static samples whenever that is what it
 * gets. No branch here can throw, so a signed-in visitor with a broken backend
 * sees a working landing page rather than an error page.
 */
async function latestScanLines(cookie: string): Promise<TerminalSample | null> {
  if (!cookie) return null;
  try {
    const headersInit = { cookie };
    const historyRes = await fetch(`${BACKEND}/api/v1/history`, {
      headers: headersInit,
      cache: "no-store",
    });
    if (!historyRes.ok) return null;
    const history = (await historyRes.json()) as { items?: HistoryItem[] };
    const items = Array.isArray(history?.items) ? history.items : [];
    const newest = items[0];
    if (!newest?.scan_id) return null;

    const scanRes = await fetch(`${BACKEND}/api/v1/scan/${encodeURIComponent(newest.scan_id)}`, {
      headers: headersInit,
      cache: "no-store",
    });
    if (!scanRes.ok) return null;
    return terminalLinesFromScan((await scanRes.json()) as ScanResult);
  } catch {
    return null;
  }
}

export default async function Home() {
  // Read the session the same way the auth client expects it, then only ask the
  // backend about history if there is one. `auth.api.getSession` is imported
  // lazily so a landing visit never fails on an auth misconfiguration.
  let cookie = "";
  let signedIn = false;
  try {
    const requestHeaders = await headers();
    const { auth } = await import("@/lib/auth");
    const session = await auth.api.getSession({ headers: requestHeaders });
    if (session?.user) {
      cookie = requestHeaders.get("cookie") ?? "";
      signedIn = true;
    }
  } catch {
    cookie = "";
    signedIn = false;
  }

  const sample = await latestScanLines(cookie);

  return (
    <div className="relative isolate bg-background text-foreground dark:bg-[#0a0f14] dark:text-neutral-100">
      {/* Full-bleed ambient layer behind nav + hero: spans the whole viewport
          width (no centered max-w strip → no hard vertical edges) and fades
          out toward the bottom so nothing reads as a cut-off rectangle.
          Decorative only: pointer-events-none, behind content via -z-10. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[100dvh] overflow-hidden [mask-image:linear-gradient(to_bottom,black_58%,transparent)]"
      >
        <AmbientBackdrop variant="landing" />
        <ParallaxField />
      </div>
      <Nav />
      <main>
        <Hero sample={sample} signedIn={signedIn} />
        <LogoStrip />
        <FeatureBento />
        <HowItWorks />
        <SecurityStrip />
        <StackStrip />
        <CtaFooter />
      </main>
    </div>
  );
}