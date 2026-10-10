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
      setError(parsed.error.issues[0]?.message ?? "We could not read that as a web address. Try a domain such as example.com.");
      return;
    }
    setError(null);
    onSubmit(parsed.data, force);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2" aria-label="target search">
      <div className="flex gap-2">
        <Input
          id="target-search"
          placeholder="example.com or 1.1.1.1"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label="scan target"
        />
        <Button type="submit" disabled={loading}>
          {loading ? "Scanning…" : "Scan"}
        </Button>
      </div>
      <div className="flex flex-col gap-1">
        <label className="flex items-center gap-2 text-xs opacity-70">
          <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
          Ask every source again, even if we already have recent results
        </label>
        <p className="text-xs opacity-60">
          Leave this off to reuse the results we already hold. Turn it on when you want the latest data for a
          target you have scanned before.
        </p>
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </form>
  );
}
