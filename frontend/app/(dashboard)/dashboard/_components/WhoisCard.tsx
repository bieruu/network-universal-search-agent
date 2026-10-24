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
const WITHHELD = "The registry hides this to protect the registrant.";

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
          {scan ? `Registration details for ${scan.target}.` : termNote("whois")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-24" />
        ) : !w ? (
          <p className="text-sm text-fg-muted">
            No registration details came back for this target. That is not the same as none.
          </p>
        ) : (
          <dl className="space-y-1.5 text-sm">
            <div>
              <dt className="inline text-fg-muted" title={termNote("registrant")}>
                {TERM.registrant.label}:{" "}
              </dt>
              <dd className="inline">{w.registrar ?? "Not published"}</dd>
            </div>
            <div>
              <dt className="inline text-fg-muted">First registered: </dt>
              <dd className="inline">{w.creation_date ?? "Not published"}</dd>
            </div>
            <div>
              <dt className="inline text-fg-muted">Expires: </dt>
              <dd className="inline">{w.expiration_date ?? "Not published"}</dd>
            </div>
            <div>
              <dt className="inline text-fg-muted" title={termNote("nameservers")}>
                {TERM.nameservers.label}:{" "}
              </dt>
              <dd className="inline">{w.name_servers?.join(", ") ?? "Not published"}</dd>
            </div>
            <div>
              <dt className="inline text-fg-muted">Contact addresses: </dt>
              <dd className="inline">{w.emails ?? WITHHELD}</dd>
            </div>
          </dl>
        )}
      </CardContent>
    </Card>
  );
}