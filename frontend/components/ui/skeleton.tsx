import { cn } from "@/lib/utils";

export function Skeleton({ className }: { className?: string }) {
  return <div aria-label="loading" className={cn("animate-pulse rounded-md bg-skeleton", className ?? "h-4 w-full")} />;
}
