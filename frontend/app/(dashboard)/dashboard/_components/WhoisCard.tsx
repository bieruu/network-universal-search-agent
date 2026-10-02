"use client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle>WHOIS</CardTitle>
        <CardDescription>{scan ? `Domain ${scan.target}` : "Registrar record"}</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-24" />
        ) : !w ? (
          <p className="text-sm text-slate-500 dark:text-neutral-500">No WHOIS data.</p>
        ) : (
          <dl className="space-y-1.5 text-sm">
            <div><dt className="inline text-slate-500 dark:text-neutral-500">Registrar: </dt><dd className="inline">{w.registrar ?? "—"}</dd></div>
            <div><dt className="inline text-slate-500 dark:text-neutral-500">Created: </dt><dd className="inline">{w.creation_date ?? "—"}</dd></div>
            <div><dt className="inline text-slate-500 dark:text-neutral-500">Expires: </dt><dd className="inline">{w.expiration_date ?? "—"}</dd></div>
            <div><dt className="inline text-slate-500 dark:text-neutral-500">NS: </dt><dd className="inline">{w.name_servers?.join(", ") ?? "—"}</dd></div>
            <div><dt className="inline text-slate-500 dark:text-neutral-500">Emails: </dt><dd className="inline">{w.emails ?? "redacted"}</dd></div>
          </dl>
        )}
      </CardContent>
    </Card>
  );
}
