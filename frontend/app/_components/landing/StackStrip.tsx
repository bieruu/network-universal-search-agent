"use client";

import {
  Activity,
  AppWindow,
  Blocks,
  Braces,
  Database,
  FileCode2,
  GitBranch,
  Lock,
  Server,
  Waves,
  Wind,
} from "lucide-react";
import ToolchainMarquee, {
  type ToolchainItem,
} from "@/components/ui/toolchain-marquee";
import Reveal from "./Reveal";

/**
 * The tech stack this product is actually built with, as two drifting rows.
 *
 * WHY A MARQUEE AND NOT A WALL
 * ----------------------------
 * A logo wall answers "what is this built with?" by dumping every mark at the
 * same size, which reads as decoration; a dock (the first attempt) made the
 * same marks interactive for no gain — nothing happens when you click a
 * framework. Two rows of drifting badges carry the same information, stay out
 * of the way, and fit a longer list without either truncating it or turning the
 * section into a grid of dead squares.
 *
 * WHAT THE ROWS CLAIM
 * -------------------
 * Every entry is a name this project actually ships with: a `package.json`
 * dependency, a `backend/requirements.txt` dependency, or the database itself
 * (PostgreSQL), whose drivers are `pg` on the frontend and `asyncpg` on the
 * backend. That constraint is the point: a tech-stack section that invents a
 * tool to fill a row is a false claim about the product, and it is the one
 * thing here that cannot be fixed later by a designer.
 * `duration` is deliberately slow — the fastest row crosses in ~22s — so the
 * section never reads as urgency, and the drift stops entirely under
 * `prefers-reduced-motion`, where the rows become scrollable instead.
 *
 * The marks keep vendor colour (PostgreSQL blue, Tailwind cyan) rather than
 * the accent: flattening them to one colour misidentifies the tools and wastes
 * the one thing a brand mark is for. Next.js is the exception — its glyph is
 * near-black — so it takes the page's ink per theme. Those colours live in the
 * component's own CSS module, which is the only place on the page they appear.
 */

/** Frontend row — everything here is in `frontend/package.json`. */
const FRONTEND: ToolchainItem[] = [
  { label: "Next.js", icon: <AppWindow />, accent: "var(--tool-nextjs)" },
  { label: "TypeScript", icon: <FileCode2 />, accent: "var(--tool-typescript)" },
  { label: "Tailwind CSS", icon: <Wind />, accent: "var(--tool-tailwind)" },
  { label: "Zod", icon: <Braces />, accent: "var(--tool-zod)" },
  { label: "Chart.js", icon: <Activity />, accent: "var(--tool-chartjs)" },
  // No vendor colour of its own: Better Auth has none, so the mark takes the
  // page accent instead of a colour invented for it.
  { label: "Better Auth", icon: <Lock />, accent: "var(--accent)" },
];

/** Backend row — everything here is in `backend/requirements.txt`. */
const BACKEND: ToolchainItem[] = [
  { label: "FastAPI", icon: <Server />, accent: "var(--tool-fastapi)" },
  { label: "SQLAlchemy", icon: <Database />, accent: "var(--tool-sqlalchemy)" },
  // PostgreSQL is the database, not a pip package — its drivers (`asyncpg`
  // here, `pg` on the frontend) are what the dependency files actually name.
  { label: "PostgreSQL", icon: <Database />, accent: "var(--tool-postgres)" },
  { label: "Alembic", icon: <GitBranch />, accent: "var(--tool-alembic)" },
  { label: "Pydantic v2", icon: <Blocks />, accent: "var(--accent)" },
  { label: "httpx", icon: <Waves />, accent: "var(--accent)" },
];

export default function StackStrip() {
  return (
    <section
      aria-label="Tech stack used"
      className="border-t border-neutral-200/80 dark:border-neutral-800/80"
    >
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 md:py-24">
        {/* The heading is what marks this section, and it is the only marker it
            gets. The dock that previously lived here also carried a mono
            eyebrow, which named the section in a voice the page reserves for
            captions — and the landing is already over its eyebrow budget
            (hero badge + how-it-works), so the heading matches How-it-works
            directly above it and tells a visitor what they are looking at
            before the first badge drifts past. */}
        <Reveal>
          <h2 className="text-center text-3xl font-bold tracking-tighter text-slate-900 dark:text-neutral-50 md:text-4xl">
            The stack this runs on
          </h2>
          <p className="mx-auto mt-3 max-w-[65ch] text-center text-sm leading-relaxed text-slate-600 dark:text-neutral-400">
            Nothing here is a claim about a future version — every name is a
            dependency this project already ships with.
          </p>
        </Reveal>

        <Reveal delay={0.05}>
          <div className="mt-8">
            {/* Rows that move on their own have to be stoppable, so the marquee
                is asked for its pause control. Without it the only way to stop
                the drift is a system-wide prefers-reduced-motion preference. */}
            <ToolchainMarquee stacks={[FRONTEND, BACKEND]} duration={22} showControl />
          </div>
        </Reveal>
      </div>
    </section>
  );
}
