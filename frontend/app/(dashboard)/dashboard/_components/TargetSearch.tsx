"use client";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
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
      {/* The label is a real <Label> above the field, not a placeholder doing a
          label's job: a placeholder disappears the moment someone types, and the
          one thing this input must always say is what belongs in it. */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="target-search">Domain or IP address</Label>
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
      </div>
      <div className="flex flex-col gap-1">
        <label className="flex items-center gap-2 text-xs opacity-70">
          <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
          Fetch fresh data instead of recent results
        </label>
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </form>
  );
}
