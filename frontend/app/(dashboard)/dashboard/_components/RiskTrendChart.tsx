"use client";
import dynamic from "next/dynamic";
import { Card, CardTitle } from "@/components/ui/card";

const RiskTrendChartInner = dynamic(() => import("./RiskTrendChartInner"), { ssr: false });

export default function RiskTrendChart({ target }: { target: string | null }) {
  if (!target) {
    return (
      <Card>
        <CardTitle>Risk trend</CardTitle>
        <p className="mt-2 text-sm opacity-60">Scan a target to see trend.</p>
      </Card>
    );
  }
  return (
    <Card>
      <CardTitle>Risk trend — {target}</CardTitle>
      <RiskTrendChartInner target={target} />
    </Card>
  );
}
