import { cn } from "@/lib/utils";
import * as React from "react";

export function buttonClasses(variant: "default" | "outline" | "ghost" = "default") {
  const base =
    "inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition-colors focus:outline-none disabled:opacity-50";
  if (variant === "outline") return cn(base, "border border-neutral-700 hover:bg-neutral-800");
  if (variant === "ghost") return cn(base, "hover:bg-neutral-800");
  return cn(base, "bg-white text-black hover:bg-neutral-200");
}

export function Button({
  className,
  variant = "default",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "outline" | "ghost";
}) {
  return <button className={buttonClasses(variant) + (className ? ` ${className}` : "")} {...props} />;
}
