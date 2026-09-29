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

ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend);

export default function PortsChartInner({ scan }: { scan: ScanResult }) {
  const ports = scan.results.shodan?.ports ?? [];
  return (
    <div aria-label="ports chart">
      <Bar
        data={{
          labels: ports.map(String),
          datasets: [{ label: "Open ports", data: ports.map(() => 1) }],
        }}
        options={{ responsive: true, plugins: { legend: { display: false } } }}
      />
    </div>
  );
}
