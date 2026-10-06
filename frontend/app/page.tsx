import type { Metadata } from "next";
import AmbientBackdrop from "./_components/landing/AmbientBackdrop";
import CtaFooter from "./_components/landing/CtaFooter";
import FeatureBento from "./_components/landing/FeatureBento";
import Hero from "./_components/landing/Hero";
import HowItWorks from "./_components/landing/HowItWorks";
import LogoStrip from "./_components/landing/LogoStrip";
import Nav from "./_components/landing/Nav";
import ParallaxField from "./_components/landing/ParallaxField";
import SecurityStrip from "./_components/landing/SecurityStrip";

export const metadata: Metadata = {
  title: "Universal Search — passive OSINT in one view",
  description: "One search box for Shodan ports, crt.sh subdomains, and WHOIS with a transparent risk score.",
};

export default function Home() {
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
        <Hero />
        <LogoStrip />
        <FeatureBento />
        <HowItWorks />
        <SecurityStrip />
        <CtaFooter />
      </main>
    </div>
  );
}
