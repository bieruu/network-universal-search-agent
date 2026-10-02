"use client";
import { Bar } from "react-chartjs-2";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
} from "chart.js";
import type { ScanResult } from "@/lib/api";
import { chartPalette, useThemeTick } from "@/lib/chart-theme";

ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend);

// Services grouped by detected product (top 8); falls back to per-port
// presence bars when no product names were detected.
function groupsFor(scan: ScanResult): Array<{ label: string; count: number }> {
  const services = scan.results.shodan?.services ?? [];
  const byProduct = new Map<string, number>();
  for (const s of services) {
    const name = (s.product || "").trim() || `port ${s.port}`;
    byProduct.set(name, (byProduct.get(name) ?? 0) + 1);
  }
  if (byProduct.size > 0) {
    return Array.from(byProduct.entries())
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
  }
  return (scan.results.shodan?.ports ?? []).slice(0, 12).map((p) => ({ label: String(p), count: 1 }));
}

export default function PortsChartInner({ scan }: { scan: ScanResult }) {
  useThemeTick();
  const pal = chartPalette();
  const groups = groupsFor(scan);
  return (
    <div className="h-[240px]" aria-label="ports chart">
      <Bar
        data={{
          labels: groups.map((g) => g.label),
          datasets: [
            {
              label: "Services",
              data: groups.map((g) => g.count),
              backgroundColor: pal.accentBar,
              hoverBackgroundColor: pal.accentBarHover,
              borderColor: pal.accent,
              borderWidth: 1,
              borderRadius: 4,
            },
          ],
        }}
        options={{
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { color: pal.grid }, ticks: { color: pal.tick, maxRotation: 45, minRotation: 0 } },
            y: { beginAtZero: true, grid: { color: pal.grid }, ticks: { color: pal.tick, precision: 0 } },
          },
        }}
      />
    </div>
  );
}
