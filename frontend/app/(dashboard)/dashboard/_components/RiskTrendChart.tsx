"use client";
import dynamic from "next/dynamic";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import CardWash from "./card-wash";

const RiskTrendChartInner = dynamic(() => import("./RiskTrendChartInner"), { ssr: false });

export default function RiskTrendChart({ target }: { target: string | null }) {
  return (
    <Card className="relative flex min-h-[320px] flex-col overflow-hidden">
      <CardWash index={1} />
      <CardHeader className="relative">
        <CardTitle>Risk trend{target ? ` — ${target}` : ""}</CardTitle>
        <CardDescription>
          {target
            ? "Risk score across the scans saved for this target."
            : "Run a scan to see how the risk score moves over time."}
        </CardDescription>
      </CardHeader>
      <CardContent className="relative flex-1">
        {!target ? (
          <p className="flex h-[240px] items-center justify-center text-sm text-slate-500 dark:text-neutral-500">
            Nothing to chart yet — a few scans of the target are needed.
          </p>
        ) : (
          <RiskTrendChartInner target={target} />
        )}
      </CardContent>
    </Card>
  );
}
