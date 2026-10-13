import type { Metadata } from "next";
import { headers } from "next/headers";
import { JetBrains_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";

export const metadata: Metadata = {
  title: "NUSA project — see what a domain exposes",
  description:
    "Search a domain or IP and read its open ports, subdomain names, registration details, and a risk score in one place.",
};

const grotesk = Space_Grotesk({ subsets: ["latin"], display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], display: "swap", variable: "--font-landing-mono" });

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The inline theme bootstrap below has no external file it could be moved
  // into, so the only way to allow it under an enforcing CSP is a nonce.
  // `headers()` is safe to call here: the routes this app renders are already
  // dynamic (`app/page.tsx` and `app/(auth)/sign-up/page.tsx` both export
  // `dynamic = "force-dynamic"`), so nothing is being lost from static
  // generation — this only hands the render the nonce the middleware minted
  // for this request.
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className={`min-h-screen bg-background text-foreground antialiased ${grotesk.className} ${mono.variable}`}>
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: `
              (() => {
                try {
                  const saved = window.localStorage.getItem('theme');
                  const isDark = saved ? saved === 'dark' : true;
                  document.documentElement.classList.toggle('dark', isDark);
                  document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
                } catch (error) {
                  document.documentElement.classList.add('dark');
                  document.documentElement.style.colorScheme = 'dark';
                }
              })();
            `,
          }}
        />
        {children}
      </body>
    </html>
  );
}