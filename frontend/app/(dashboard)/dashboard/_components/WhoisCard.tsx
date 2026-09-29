"use client";
import { Card, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { ScanResult } from "@/lib/api";

export default function WhoisCard({
  scan,
  loading,
}: {
  scan: ScanResult | null;
  loading: boolean;
}) {
  const w = scan?.results.whois;
  return (
    <Card>
      <CardTitle>WHOIS</CardTitle>
      {loading ? (
        <Skeleton className="mt-2 h-24" />
      ) : !w ? (
        <p className="mt-2 text-sm opacity-60">No WHOIS data.</p>
      ) : (
        <dl className="mt-2 space-y-1 text-sm">
          <div><dt className="inline opacity-60">Registrar: </dt><dd className="inline">{w.registrar ?? "—"}</dd></div>
          <div><dt className="inline opacity-60">Created: </dt><dd className="inline">{w.creation_date ?? "—"}</dd></div>
          <div><dt className="inline opacity-60">Expires: </dt><dd className="inline">{w.expiration_date ?? "—"}</dd></div>
          <div><dt className="inline opacity-60">NS: </dt><dd className="inline">{w.name_servers?.join(", ") ?? "—"}</dd></div>
          <div><dt className="inline opacity-60">Emails: </dt><dd className="inline">{w.emails ?? "redacted"}</dd></div>
        </dl>
      )}
    </Card>
  );
}
