"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";

import { cn } from "@/lib/utils";

const Sheet = DialogPrimitive.Root;
const SheetTrigger = DialogPrimitive.Trigger;
const SheetClose = DialogPrimitive.Close;

type SheetSide = "left" | "right";

const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { side?: SheetSide }
>(({ className, side = "right", ...props }, ref) => (
  <DialogPrimitive.Portal>
    {/* The scrim is the other half of the panel's motion, not a separate effect:
        Radix unmounts overlay and content on their OWN animationend, so if only
        the panel animated, the page behind would snap back to full brightness
        while the panel was still travelling (AGENTS.md §6: the overlay fades
        together with the sheet). `motion-safe:` is written gate-first so the
        gate wraps the data-state condition; under reduce, no animation name is
        ever computed and Radix unmounts on the same tick it closes - nothing
        can stay stuck on screen. */}
    <DialogPrimitive.Overlay
      className={cn(
        "fixed inset-0 bg-black/60",
        "motion-safe:data-[state=open]:animate-overlay-in motion-safe:data-[state=closed]:animate-overlay-out",
      )}
    />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        // bg-background, NOT a hard-coded near-black (this was `bg-neutral-950`
        // until 2026-10-16). The sheet embeds App1Sidebar, which paints
        // bg-background, and the sheet's own p-4 padding, gap-4 and header band
        // show through AROUND that panel - in light mode the two surfaces were
        // white against #0a0a0a, so the mobile burger menu opened with a solid
        // black frame around the app's own navigation ("outline hitam di luar
        // NUSA project utama", operator report 2026-10-16, measured as black
        // pixel runs x=0–15 / x=271–288 / y=0–51 at 390px). One surface token
        // means one surface in both themes.
        // overflow-hidden: the sheet is a fixed column that must not scroll as
        // a whole. Its embedded sidebar owns the only scroll area and keeps the
        // Log out footer pinned below it (operator report 2026-10-21: that
        // footer used to sit past the fold because the sheet itself scrolled).
        // focus:outline-hidden: Radix autofocuses this panel the moment it
        // opens, and Chrome's UA focus ring is `outline: auto 1px` painted
        // around the WHOLE panel - measured rgb(16,16,16) in light (the literal
        // "outline hitam di luar NUSA project utama", operator 2026-10-16) and
        // rgb(238,238,238) in dark. A ring on a full-height surface reads as a
        // stray frame, not as focus: the panel is tabIndex -1, not a tab stop,
        // and the first control inside carries the real indicator - the same
        // treatment `buttonClasses` gives every button in this repo.
        // focus-visible ring (SEC-001, 2026-10-16): hiding the UA outline left
        // one gap. Radix's FocusScope can focus the PANEL itself - its
        // focus(container) fallback after a focused node is removed - and
        // against focus:outline-hidden that path painted NO indicator. The ring
        // below is the keyboard-only replacement: :focus-visible matches for
        // programmatic focus only when the keyboard was the last input
        // modality, so opening the burger with Enter paints a 2px accent ring
        // inset on the panel, while a mouse-opened sheet stays ring-less (the
        // click was its own feedback, and the full-panel frame the outline
        // removal deleted does not come back for pointer users). focus:
        // outline-hidden stays because lib/dashboard.test.ts pins it - the ring
        // complements it, it does not replace it.
        "fixed inset-y-0 flex w-72 flex-col gap-4 overflow-hidden bg-background p-4 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40",
        // Enter/exit, CSS-only: Radix keeps the node mounted until animationend
        // and drops it instantly when no animation name computes (the reduce
        // path). `--sheet-off` below is the distance from the sheet's own edge;
        // it is per side because the keyframes are shared and cn() is a plain
        // join - both offsets in one class list would let stylesheet order pick
        // the direction.
        "motion-safe:data-[state=open]:animate-sheet-in motion-safe:data-[state=closed]:animate-sheet-out",
        // Conditional, never both: cn() is a plain join (no tailwind-merge), so
        // appending both sides' classes would let stylesheet order decide.
        // The border token matches the desktop sidebar's edge, so the mobile
        // sheet's edge and the desktop aside's edge are the same edge.
        side === "left"
          ? "left-0 border-r border-btn-border [--sheet-off:-100%]"
          : "right-0 border-l border-btn-border [--sheet-off:100%]",
        className,
      )}
      {...props}
    />
  </DialogPrimitive.Portal>
));
SheetContent.displayName = DialogPrimitive.Content.displayName;

const SheetHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col gap-1", className)} {...props} />
);

const SheetTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn("text-sm font-semibold", className)} {...props} />
));
SheetTitle.displayName = DialogPrimitive.Title.displayName;

export { Sheet, SheetTrigger, SheetClose, SheetContent, SheetHeader, SheetTitle };
