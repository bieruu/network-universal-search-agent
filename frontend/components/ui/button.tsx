import { cn } from "@/lib/utils";
import * as React from "react";

export type ButtonVariant =
  | "default"
  | "outline"
  | "ghost"
  | "secondary"
  | "destructive"
  | "link"
  | "accent";
export type ButtonSize = "default" | "sm" | "lg" | "icon";

export function buttonClasses(
  variant: ButtonVariant = "default",
  size: ButtonSize = "default",
) {
  const base =
    "inline-flex items-center justify-center rounded-full text-sm font-medium transition-colors focus:outline-hidden disabled:opacity-50";
  const sizes =
    size === "sm"
      ? "h-8 px-3 text-xs"
      : size === "lg"
        ? "h-11 px-6 text-base"
        : size === "icon"
          ? "h-10 w-10 p-0"
          : "h-9 px-4 py-2";
  if (variant === "outline") return cn(base, sizes, "border border-neutral-300 bg-transparent hover:border-accent/40 hover:bg-accent/10 dark:border-neutral-700 dark:hover:border-accent/40 dark:hover:bg-accent/10");
  if (variant === "ghost") return cn(base, sizes, "hover:bg-accent/10 hover:text-foreground");
  if (variant === "secondary") return cn(base, sizes, "bg-slate-100 text-slate-900 hover:bg-accent/15 dark:bg-neutral-800 dark:text-neutral-100 dark:hover:bg-accent/15");
  if (variant === "destructive") return cn(base, sizes, "border border-red-200 bg-red-100 text-red-700 hover:bg-red-200 dark:border-red-800 dark:bg-red-950 dark:text-red-200 dark:hover:bg-red-900");
  if (variant === "link") return cn(base, sizes, "text-accent underline-offset-4 hover:underline px-0");
  if (variant === "accent") return cn(base, sizes, "bg-accent text-accent-foreground hover:bg-accent-hover");
  return cn(base, sizes, "bg-slate-900 text-white hover:bg-slate-800 dark:bg-white dark:text-black dark:hover:bg-neutral-200");
}

export const Button = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: ButtonVariant;
    size?: ButtonSize;
  }
>(function Button({ className, variant = "default", size = "default", ...props }, ref) {
  return <button ref={ref} className={buttonClasses(variant, size) + (className ? ` ${className}` : "")} {...props} />;
});
Button.displayName = "Button";
