"use client";

import type { ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  Activity,
  Bell,
  Database,
  Eye,
  Globe,
  Key,
  Search,
  Server,
  ShieldCheck,
} from "lucide-react";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { cn } from "@/lib/utils";

const ORBIT_ICONS = [ShieldCheck, Server, Globe, Key, Eye, Activity, Database, Bell, Search];

function Reveal({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  const reduce = useReducedMotion();
  if (reduce) return <div>{children}</div>;
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 100, damping: 20, delay }}
    >
      {children}
    </motion.div>
  );
}

export function AuthShell({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  const reduce = useReducedMotion();

  return (
    <main className="relative grid min-h-screen grid-cols-1 bg-background text-foreground dark:bg-[#0a0f14] dark:text-neutral-100 lg:grid-cols-2">
      <div className="absolute right-4 top-4 z-20">
        <ThemeToggle className="border border-border/60 bg-background/80 text-foreground hover:bg-accent/10" />
      </div>
      <div className="relative hidden items-center justify-center overflow-hidden border-r border-neutral-200 dark:border-neutral-800 lg:flex">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_42%,rgba(0,229,155,0.09),transparent_62%)]" />
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(rgba(255,255,255,0.055)_1px,transparent_1px)] [background-size:22px_22px]" />
        <div
          className="relative flex h-[clamp(18rem,30vw,24rem)] w-[clamp(18rem,30vw,24rem)] items-center justify-center"
          aria-hidden="true"
          style={{ ["--orbit-r" as string]: "clamp(104px, 11.5vw, 140px)" }}
        >
          {!reduce && <span className="absolute inset-6 animate-[spin_60s_linear_infinite] rounded-full border border-dashed border-accent/20" />}
          <span className="absolute inset-14 rounded-full border border-neutral-200 dark:border-neutral-800" />
          <div className={cn("absolute inset-0", !reduce && "animate-[spin_36s_linear_infinite]")}>
            {ORBIT_ICONS.map((Icon, index) => (
              <span
                key={index}
                className="absolute left-1/2 top-1/2 flex h-10 w-10 items-center justify-center rounded-full border border-neutral-300 bg-slate-100 dark:border-neutral-700 dark:bg-neutral-900"
                style={{ transform: `translate(-50%, -50%) rotate(${index * 40}deg) translateY(calc(var(--orbit-r) * -1))` }}
              >
                <span className={cn("flex", !reduce && "animate-[spin_36s_linear_infinite_reverse]")}>
                  <Icon size={20} strokeWidth={2} className="text-accent" />
                </span>
              </span>
            ))}
          </div>
          <span className={cn("relative flex h-20 w-20 items-center justify-center rounded-2xl bg-accent font-mono text-3xl font-bold text-accent-foreground", !reduce && "animate-float")}>
            N
          </span>
        </div>
        <div className="absolute inset-x-12 bottom-8">
          <p className="font-mono text-xs uppercase tracking-widest text-accent">Universal Search</p>
          <p className="mt-2 max-w-[40ch] text-sm text-slate-600 dark:text-neutral-400">
            Passive OSINT console. Shodan, crt.sh and WHOIS in one scan with audit trail.
          </p>
        </div>
      </div>

      <div className="flex w-full items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-sm py-6">
          <div className="mb-6 flex items-center gap-2.5 lg:hidden">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent font-mono text-lg font-bold text-accent-foreground">N</span>
            <span className="flex flex-col leading-none">
              <span className="font-mono text-sm font-semibold tracking-tight text-slate-900 dark:text-neutral-100">Universal Search</span>
              <span className="mt-1 font-mono text-[10px] uppercase tracking-widest text-accent">OSINT Console</span>
            </span>
          </div>
          <Reveal>
            <p className="font-mono text-xs uppercase tracking-widest text-accent">Universal Search</p>
            <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-900 dark:text-neutral-100">{title}</h1>
            <p className="mt-1 text-sm text-slate-600 dark:text-neutral-400">{description}</p>
          </Reveal>
          <Reveal delay={0.08}>{children}</Reveal>
        </div>
      </div>
    </main>
  );
}
