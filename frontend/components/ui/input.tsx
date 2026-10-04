import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          "w-full rounded-md border border-accent/40 bg-accent/5 px-3 py-2 text-sm text-slate-900 outline-hidden transition-colors placeholder:text-slate-400 hover:border-accent/60 focus:border-accent focus:bg-accent/10 focus:ring-2 focus:ring-accent/30 dark:text-neutral-100 dark:placeholder:text-neutral-500",
          className,
        )}
        {...props}
      />
    );
  },
);
