export default function AmbientBackdrop({ variant = "landing" }: { variant?: "landing" | "auth" }) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      {/* Single accent wash: static by default, slow drift only when motion is allowed. */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_30%,hsl(var(--accent)/0.11),transparent_62%)] motion-safe:animate-ambient-pulse" />
      {/* Hairline grid on the same formula in both themes. */}
      <div
        className={
          variant === "landing"
            ? "absolute inset-0 bg-[radial-gradient(hsl(var(--foreground)/0.06)_1px,transparent_1px)] [background-size:26px_26px] motion-safe:animate-ambient-drift"
            : "absolute inset-0 bg-[radial-gradient(hsl(var(--foreground)/0.06)_1px,transparent_1px)] [background-size:22px_22px]"
        }
      />
    </div>
  );
}
