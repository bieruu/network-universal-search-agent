"use client";
import dynamic from "next/dynamic";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const RiskTrendChartInner = dynamic(() => import("./RiskTrendChartInner"), { ssr: false });

export default function RiskTrendChart({ target }: { target: string | null }) {
  return (
    <Card className="flex min-h-[320px] flex-col">
      <CardHeader>
        <CardTitle>Risk trend{target ? ` — ${target}` : ""}</CardTitle>
        <CardDescription>{target ? "Risk score of the last scans" : "Scan a target to see its history"}</CardDescription>
      </CardHeader>
      <CardContent className="flex-1">
        {!target ? (
          <p className="flex h-[240px] items-center justify-center text-sm text-slate-500 dark:text-neutral-500">
            Scan a target to see trend.
          </p>
        ) : (
          <RiskTrendChartInner target={target} />
        )}
      </CardContent>
    </Card>
  );
}
