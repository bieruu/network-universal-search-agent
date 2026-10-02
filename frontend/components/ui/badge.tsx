import * as React from "react";
import { cn } from "@/lib/utils";

export function Badge({
  className,
  variant = "default",
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { variant?: "default" | "destructive" | "outline" | "secondary" }) {
  const styles =
    variant === "destructive"
      ? "border-red-200 bg-red-100 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300"
      : variant === "outline"
        ? "border-btn-border text-slate-600 dark:text-neutral-400"
        : variant === "secondary"
          ? "bg-input text-foreground border-btn-border"
          : "bg-input text-foreground border-btn-border";
  return (
    <span
      className={cn("inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs", styles, className)}
      {...props}
    />
  );
}
