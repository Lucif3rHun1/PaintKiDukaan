import { type ReactNode } from "react";
import { forecastDailySeries, type DataPoint } from "../../../analytics/forecast";
import { formatRupeesCompact } from "../../../lib/money";

interface RowProps {
  icon: React.ElementType<{ className?: string }>;
  label: string;
  value: ReactNode;
}

export function Row({ icon: Icon, label, value }: RowProps) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-2 text-muted-foreground">
        <Icon className="h-4 w-4" />
        {label}
      </span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}

interface TwoLineTrendProps {
  sales: number[];
  purchases: number[];
  labels?: string[];
}

function shortDate(label: string): string {
  const [, month, day] = label.split("-");
  return month && day ? `${day}/${month}` : label;
}

export function TwoLineTrend({ sales, purchases, labels = [] }: TwoLineTrendProps) {
  const len = Math.max(sales.length, purchases.length, labels.length);
  if (len === 0) return null;
  const safeLen = Math.max(len, 1);
  const salesSeries = normalizeSeries(sales, labels, safeLen);
  const purchaseSeries = normalizeSeries(purchases, labels, safeLen);
  const forecast = forecastDailySeries(salesSeries);
  const forecastSales = forecast.kind === "forecast" ? forecast.points.filter((point) => point.isForecast) : [];
  const all = [...salesSeries.map((point) => point.value), ...purchaseSeries.map((point) => point.value), ...forecastSales.map((point) => point.value)];
  const max = Math.max(...all, 1);
  const min = Math.min(...all, 0);
  const range = max - min || 1;
  const width = 240;
  const height = 72;
  const chartLen = safeLen + forecastSales.length;
  const salesTotal = salesSeries.reduce((sum, point) => sum + point.value, 0);
  const purchaseTotal = purchaseSeries.reduce((sum, point) => sum + point.value, 0);
  const firstLabel = shortDate(salesSeries[0]?.date ?? "Start");
  const lastActualLabel = shortDate(salesSeries[salesSeries.length - 1]?.date ?? "End");
  const toPoints = (data: readonly DataPoint[], startIndex = 0) =>
    data
      .map((v, i) => {
        const denominator = Math.max(chartLen - 1, 1);
        const x = ((i + startIndex) / denominator) * width;
        const y = height - ((v.value - min) / range) * height;
        return `${x},${y}`;
      })
      .join(" ");
  const forecastLine = forecast.kind === "forecast" ? [salesSeries[salesSeries.length - 1], ...forecastSales].filter(Boolean) : [];

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Sales <span className="font-medium text-primary">{formatRupeesCompact(salesTotal)}</span> · Purchases{" "}
        <span className="font-medium text-info">{formatRupeesCompact(purchaseTotal)}</span> · Difference{" "}
        <span className="font-medium text-foreground">{formatRupeesCompact(salesTotal - purchaseTotal)}</span> across {safeLen} days.
      </p>
      {forecast.kind === "insufficient" ? (
        <p className="rounded-lg bg-muted/40 p-3 text-sm text-muted-foreground">{forecast.message}</p>
      ) : (
        <>
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="h-24 w-full"
            preserveAspectRatio="none"
            role="img"
            aria-label="Daily sales and purchases trend"
          >
            <line x1="0" y1={height / 2} x2={width} y2={height / 2} className="stroke-border/60" strokeWidth="1" />
            <polyline
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              points={toPoints(salesSeries)}
              className="text-primary"
            />
            <polyline
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              points={toPoints(purchaseSeries)}
              className="text-info"
            />
            {forecastLine.length > 1 ? (
              <polyline
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeDasharray="5 5"
                strokeLinecap="round"
                strokeLinejoin="round"
                points={toPoints(forecastLine, safeLen - 1)}
                className="text-primary"
                opacity="0.55"
              />
            ) : null}
          </svg>
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>{firstLabel}</span>
            <span>{lastActualLabel}</span>
          </div>
        </>
      )}
      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-3 rounded-sm bg-primary" />
          Sales
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-3 rounded-sm bg-info" />
          Purchases
        </span>
        {forecast.kind === "forecast" ? (
          <span className="flex items-center gap-1">
            <span className="inline-block h-0.5 w-4 border-t border-dashed border-primary" />
            Sales forecast
          </span>
        ) : null}
      </div>
      {forecast.kind === "actuals" || forecast.kind === "forecast" ? <p className="text-xs text-muted-foreground">{forecast.message}</p> : null}
    </div>
  );
}

function normalizeSeries(values: readonly number[], labels: readonly string[], length: number): readonly DataPoint[] {
  return Array.from({ length }, (_value, index) => ({
    date: labels[index] ?? `Day ${index + 1}`,
    value: Math.max(values[index] ?? 0, 0),
  }));
}

interface DonutProps {
  healthy: number;
  low: number;
  zero: number;
  negative: number;
}

export function Donut({ healthy, low, zero, negative }: DonutProps) {
  const total = Math.max(healthy + low + zero + negative, 1);
  const healthyPct = (healthy / total) * 100;
  const lowPct = (low / total) * 100;
  const zeroPct = (zero / total) * 100;
  const negativePct = (negative / total) * 100;
  // Render four arcs as conic-gradient style: use a single SVG ring with
  // dashoffset math on a circle of circumference 2*PI*r.
  const r = 36;
  const c = 2 * Math.PI * r;
  const healthyLen = (healthyPct / 100) * c;
  const lowLen = (lowPct / 100) * c;
  const zeroLen = (zeroPct / 100) * c;
  const negativeLen = (negativePct / 100) * c;
  const segments = [
    { len: healthyLen, color: "stroke-success" },
    { len: lowLen, color: "stroke-warning" },
    { len: zeroLen, color: "stroke-destructive" },
    { len: negativeLen, color: "stroke-info" },
  ];
  let offset = 0;
  return (
    <div className="flex items-center gap-4">
      <svg viewBox="0 0 100 100" className="h-24 w-24 -rotate-90" aria-hidden="true">
        <circle
          cx="50"
          cy="50"
          r={r}
          fill="none"
          strokeWidth="14"
          className="stroke-muted"
        />
        {segments.map((s, i) => {
          if (s.len <= 0) return null;
          const dashArray = `${s.len} ${c - s.len}`;
          const dashOffset = -offset;
          offset += s.len;
          return (
            <circle
              key={i}
              cx="50"
              cy="50"
              r={r}
              fill="none"
              strokeWidth="14"
              strokeDasharray={dashArray}
              strokeDashoffset={dashOffset}
              className={s.color}
            />
          );
        })}
      </svg>
      <ul className="space-y-1 text-sm">
        <LegendDot color="bg-success" label="Healthy" count={healthy} />
        <LegendDot color="bg-warning" label="Low" count={low} />
        <LegendDot color="bg-destructive" label="Zero" count={zero} />
        <LegendDot color="bg-info" label="Negative" count={negative} />
      </ul>
    </div>
  );
}

function LegendDot({ color, label, count }: { color: string; label: string; count: number }) {
  return (
    <li className="flex items-center gap-2">
      <span className={`inline-block h-2 w-2 rounded-full ${color}`} aria-hidden="true" />
      <span className="flex-1 text-muted-foreground">{label}</span>
      <span className="tabular-nums font-medium">{count}</span>
    </li>
  );
}
