import { cn } from "@/lib/utils";

export function Skeleton({ className }: { className?: string }) {
  // `motion-safe:` - a skeleton that pulses forever is a loop, and the project's
  // first motion floor (lib/loop-contract.test.ts) has no exception for
  // "loading" states: under prefers-reduced-motion it is a flat block.
  return <div aria-label="loading" className={cn("motion-safe:animate-pulse rounded-md bg-skeleton", className ?? "h-4 w-full")} />;
}
