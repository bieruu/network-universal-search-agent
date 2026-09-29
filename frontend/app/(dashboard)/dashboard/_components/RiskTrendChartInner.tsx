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

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend);

export default function RiskTrendChartInner({ target }: { target: string }) {
  const [points, setPoints] = useState<Array<{ created_at: string; risk_score: number | null }>>([]);

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

  if (points.length === 0) {
    return <p className="mt-2 text-sm opacity-60">No trend data yet.</p>;
  }
  return (
    <div aria-label="risk trend chart">
      <Line
        data={{
          labels: points.map((p) => p.created_at.slice(0, 10)),
          datasets: [
            {
              label: "Risk score",
              data: points.map((p) => p.risk_score ?? 0),
            },
          ],
        }}
        options={{ responsive: true }}
      />
    </div>
  );
}
