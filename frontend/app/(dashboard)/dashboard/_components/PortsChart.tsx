"use client";
import dynamic from "next/dynamic";
import { Card, CardTitle } from "@/components/ui/card";
import type { ScanResult } from "@/lib/api";

const PortsChartInner = dynamic(() => import("./PortsChartInner"), { ssr: false });

export default function PortsChart({ scan }: { scan: ScanResult | null }) {
  return (
    <Card>
      <CardTitle>Ports distribution</CardTitle>
      {!scan?.results.shodan?.ports?.length ? (
        <p className="mt-2 text-sm opacity-60">No port data to chart.</p>
      ) : (
        <PortsChartInner scan={scan} />
      )}
    </Card>
  );
}
