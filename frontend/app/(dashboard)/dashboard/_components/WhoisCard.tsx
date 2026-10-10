"use client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { ScanResult } from "@/lib/api";
import { TERM, termNote } from "@/lib/terms";

/**
 * The registry publishes some fields and withholds others. "redacted" told an
 * analyst nothing about who withheld them or why, and read like the value
 * itself. Spell out the cause instead.
 */
const WITHHELD = "Not published — the registry hides this to protect the registrant.";

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
        <CardTitle>{TERM.whois.label}</CardTitle>
        <CardDescription>
          {scan ? `The public registration record for ${scan.target}.` : termNote("whois")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-24" />
        ) : !w ? (
          <p className="text-sm text-slate-500 dark:text-neutral-500">
            No registration details were returned for this target. That is not the same as there being none.
          </p>
        ) : (
          <dl className="space-y-1.5 text-sm">
            <div>
              <dt className="inline text-slate-500 dark:text-neutral-500" title={termNote("registrant")}>
                {TERM.registrant.label}:{" "}
              </dt>
              <dd className="inline">{w.registrar ?? "Not published"}</dd>
            </div>
            <div>
              <dt className="inline text-slate-500 dark:text-neutral-500">First registered: </dt>
              <dd className="inline">{w.creation_date ?? "Not published"}</dd>
            </div>
            <div>
              <dt className="inline text-slate-500 dark:text-neutral-500">Expires: </dt>
              <dd className="inline">{w.expiration_date ?? "Not published"}</dd>
            </div>
            <div>
              <dt className="inline text-slate-500 dark:text-neutral-500" title={termNote("nameservers")}>
                {TERM.nameservers.label}:{" "}
              </dt>
              <dd className="inline">{w.name_servers?.join(", ") ?? "Not published"}</dd>
            </div>
            <div>
              <dt className="inline text-slate-500 dark:text-neutral-500">Contact addresses: </dt>
              <dd className="inline">{w.emails ?? WITHHELD}</dd>
            </div>
          </dl>
        )}
      </CardContent>
    </Card>
  );
}