import * as React from "react";
import { cn } from "@/lib/utils";

export function Badge({
  className,
  variant = "default",
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { variant?: "default" | "destructive" | "outline" }) {
  const styles =
    variant === "destructive"
      ? "bg-red-950 text-red-300 border-red-800"
      : variant === "outline"
        ? "border-neutral-700 text-neutral-300"
        : "bg-neutral-800 text-neutral-100 border-neutral-700";
  return (
    <span
      className={cn("inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs", styles, className)}
      {...props}
    />
  );
}
