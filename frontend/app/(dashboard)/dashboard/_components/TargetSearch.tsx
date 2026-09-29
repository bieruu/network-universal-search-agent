"use client";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { targetSchema } from "@/lib/validators";

export default function TargetSearch({
  onSubmit,
  loading,
}: {
  onSubmit: (target: string, force: boolean) => void;
  loading: boolean;
}) {
  const [value, setValue] = useState("");
  const [force, setForce] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = targetSchema.safeParse(value);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid target");
      return;
    }
    setError(null);
    onSubmit(parsed.data, force);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2" aria-label="target search">
      <div className="flex gap-2">
        <Input
          placeholder="example.com or 1.1.1.1"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label="scan target"
        />
        <Button type="submit" disabled={loading}>
          {loading ? "Scanning…" : "Scan"}
        </Button>
      </div>
      <label className="flex items-center gap-2 text-xs opacity-70">
        <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
        Bypass cache (force=true)
      </label>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </form>
  );
}
