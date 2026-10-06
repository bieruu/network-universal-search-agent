export default function AmbientBackdrop({ variant = "landing" }: { variant?: "landing" | "auth" }) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      {/* Single emerald wash: static by default, slow drift only when motion is allowed. */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_30%,rgba(0,229,155,0.11),transparent_62%)] motion-safe:animate-ambient-pulse dark:bg-[radial-gradient(circle_at_50%_30%,rgba(0,229,155,0.14),transparent_62%)]" />
      {/* Hairline grid: faint, non-looping in light; slow drift in dark via opacity-safe layer. */}
      <div
        className={
          variant === "landing"
            ? "absolute inset-0 bg-[radial-gradient(rgba(15,23,42,0.07)_1px,transparent_1px)] [background-size:26px_26px] motion-safe:animate-ambient-drift dark:bg-[radial-gradient(rgba(255,255,255,0.065)_1px,transparent_1px)]"
            : "absolute inset-0 bg-[radial-gradient(rgba(15,23,42,0.05)_1px,transparent_1px)] [background-size:22px_22px] dark:bg-[radial-gradient(rgba(255,255,255,0.055)_1px,transparent_1px)]"
        }
      />
    </div>
  );
}
