import { motion } from "motion/react";

interface AnalyticsChartProps {
  data: Array<{ date: string; avgDelay: number; count: number }>;
  title?: string;
}

export default function AnalyticsChart({ data, title = "Response Delay Trend" }: AnalyticsChartProps) {
  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 rounded-xl border border-line bg-white shadow-card">
        <p className="text-sm text-ink-3">No data available</p>
      </div>
    );
  }

  const maxDelay = Math.max(...data.map((d) => d.avgDelay), 1);
  const minDelay = Math.min(...data.map((d) => d.avgDelay), 0);

  return (
    <div className="rounded-xl border border-line bg-white shadow-card p-4">
      <h3 className="text-sm font-medium text-ink mb-4">{title}</h3>
      <div className="flex items-end gap-2 h-40">
        {data.map((point, index) => {
          const height = ((point.avgDelay - minDelay) / (maxDelay - minDelay || 1)) * 100;
          return (
            <div key={index} className="flex-1 flex flex-col items-center gap-1">
              <motion.div
                initial={{ height: 0 }}
                animate={{ height: `${Math.max(height, 2)}%` }}
                transition={{ duration: 0.5, delay: index * 0.05 }}
                className="w-6 bg-brand rounded-t-lg"
                style={{ minHeight: 4 }}
              />
              <span className="text-[10px] text-ink-3">
                {point.date.slice(5)}
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-4 flex justify-between text-[10px] text-ink-3">
        <span>Min: {minDelay}s</span>
        <span>Max: {maxDelay}s</span>
      </div>
    </div>
  );
}
