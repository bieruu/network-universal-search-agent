"use client";
import { useEffect, useState } from "react";
import { Line } from "react-chartjs-2";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
} from "chart.js";
import { fetchTrend } from "@/lib/api";
import { chartPalette, useThemeTick } from "@/lib/chart-theme";

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend);

export default function RiskTrendChartInner({ target }: { target: string }) {
  const [points, setPoints] = useState<Array<{ created_at: string; risk_score: number | null }>>([]);
  useThemeTick();

  useEffect(() => {
    let live = true;
    fetchTrend(target)
      .then((d) => {
        if (live) setPoints(d.points);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [target]);

  const pal = chartPalette();
  if (points.length === 0) {
    return (
      <p className="flex h-[240px] items-center justify-center text-sm text-slate-500 dark:text-neutral-500">
        No trend data yet.
      </p>
    );
  }
  return (
    <div className="h-[240px]" aria-label="risk trend chart">
      <Line
        data={{
          labels: points.map((p) => p.created_at.slice(0, 10)),
          datasets: [
            {
              label: "Risk score",
              data: points.map((p) => p.risk_score ?? 0),
              borderColor: pal.accent,
              backgroundColor: pal.accentSoft,
              pointBackgroundColor: pal.accent,
              pointBorderColor: pal.accent,
              pointHoverBackgroundColor: pal.accentHover,
              pointHoverBorderColor: pal.accentHover,
              fill: true,
              tension: 0.3,
            },
          ],
        }}
        options={{
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { labels: { color: pal.tick } } },
          scales: {
            x: { grid: { color: pal.grid }, ticks: { color: pal.tick } },
            y: { beginAtZero: true, grid: { color: pal.grid }, ticks: { color: pal.tick, precision: 0 } },
          },
        }}
      />
    </div>
  );
}
