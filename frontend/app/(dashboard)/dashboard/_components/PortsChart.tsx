"use client";
import dynamic from "next/dynamic";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ScanResult } from "@/lib/api";
import { plural } from "@/lib/terms";

const PortsChartInner = dynamic(() => import("./PortsChartInner"), { ssr: false });

export default function PortsChart({ scan }: { scan: ScanResult | null }) {
  const count = scan?.results.shodan?.ports?.length ?? 0;
  const ip = scan?.results.shodan?.ip;
  return (
    <Card className="flex min-h-[320px] flex-col">
      <CardHeader>
        <CardTitle>Ports distribution</CardTitle>
        <CardDescription>
          {scan
            ? `${count} open ${plural(count, "port", "ports")} found${ip ? ` on ${ip}` : ""}, grouped by the service running behind each one.`
            : "Once you scan a target, its open ports appear here, grouped by the service running behind each one."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex-1">
        {!scan?.results.shodan?.ports?.length ? (
          <p className="flex h-[240px] items-center justify-center text-sm text-slate-500 dark:text-neutral-500">
            No port data to chart.
          </p>
        ) : (
          <PortsChartInner scan={scan} />
        )}
      </CardContent>
    </Card>
  );
}
