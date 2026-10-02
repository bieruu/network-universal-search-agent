import type { Metadata } from "next";
import CtaFooter from "./_components/landing/CtaFooter";
import FeatureBento from "./_components/landing/FeatureBento";
import Hero from "./_components/landing/Hero";
import HowItWorks from "./_components/landing/HowItWorks";
import LogoStrip from "./_components/landing/LogoStrip";
import Nav from "./_components/landing/Nav";
import SecurityStrip from "./_components/landing/SecurityStrip";

export const metadata: Metadata = {
  title: "Universal Search — passive OSINT in one view",
  description: "One search box for Shodan ports, crt.sh subdomains, and WHOIS with a transparent risk score.",
};

export default function Home() {
  return (
    <div className="bg-background text-foreground dark:bg-[#0a0f14] dark:text-neutral-100">
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
