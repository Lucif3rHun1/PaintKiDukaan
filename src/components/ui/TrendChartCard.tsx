import { forecastDailySeries, type DataPoint } from "../../analytics/forecast";
import { formatRupeesCompact } from "../../lib/money";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export interface TrendChartCardProps {
  /** Daily sales totals in paise (or raw rupees) */
  sales: readonly number[];
  /** Daily purchase totals in the same units as sales */
  purchases: readonly number[];
  /** Optional date labels for each day (e.g. "2026-07-09") */
  labels?: readonly string[];
  /** Height in pixels. Default 96. */
  height?: number;
}

interface ChartRow {
  date: string;
  label: string;
  sales: number | null;
  purchases: number | null;
  /** Same series as sales but only defined over the forecast window — rendered dashed */
  salesForecast: number | null;
}

function shortDate(label: string): string {
  const [, month, day] = label.split("-");
  return month && day ? `${day}/${month}` : label;
}

function normalizeSeries(values: readonly number[], labels: readonly string[], length: number): readonly DataPoint[] {
  return Array.from({ length }, (_value, index) => ({
    date: labels[index] ?? `Day ${index + 1}`,
    value: Math.max(values[index] ?? 0, 0),
  }));
}

/**
 * Two-line trend chart (sales vs purchases) with optional forecast overlay.
 * Built on recharts for hover tooltips and a clean rendering surface.
 *
 * Forecast series, when present, is drawn dashed and only populated over the
 * forecast window — its earlier points are `null` so the line renders as a
 * dashed continuation after the actual sales line.
 */
export function TrendChartCard({ sales, purchases, labels = [], height = 96 }: TrendChartCardProps) {
  const len = Math.max(sales.length, purchases.length, labels.length);
  if (len === 0) return null;
  const safeLen = Math.max(len, 1);
  const salesSeries = normalizeSeries(sales, labels, safeLen);
  const purchaseSeries = normalizeSeries(purchases, labels, safeLen);
  const forecast = forecastDailySeries(salesSeries);
  const forecastPoints =
    forecast.kind === "forecast" ? forecast.points.filter((point) => point.isForecast) : [];
  const salesTotal = salesSeries.reduce((sum, point) => sum + point.value, 0);
  const purchaseTotal = purchaseSeries.reduce((sum, point) => sum + point.value, 0);

  // Build a single aligned data array: one row per day (actual + forecast).
  const rows: ChartRow[] = salesSeries.map((point, i) => ({
    date: point.date,
    label: shortDate(point.date),
    sales: point.value,
    purchases: purchaseSeries[i]?.value ?? 0,
    salesForecast: null,
  }));
  if (forecast.kind === "forecast" && forecastPoints.length > 0) {
    // Anchor the forecast line to the last actual point so it joins cleanly
    const lastActual = salesSeries[salesSeries.length - 1];
    if (lastActual) {
      rows.push({
        date: lastActual.date,
        label: shortDate(lastActual.date),
        sales: lastActual.value,
        purchases: purchaseSeries[salesSeries.length - 1]?.value ?? 0,
        salesForecast: lastActual.value,
      });
    }
    for (const point of forecastPoints) {
      rows.push({
        date: point.date,
        label: shortDate(point.date),
        sales: null,
        purchases: null,
        salesForecast: point.value,
      });
    }
  }

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
        <div style={{ width: "100%", height }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="hsl(var(--border))" strokeOpacity={0.4} vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                axisLine={false}
                tickLine={false}
                interval="preserveStartEnd"
              />
              <YAxis hide domain={["auto", "auto"]} />
              <Tooltip
                contentStyle={{
                  fontSize: 12,
                  padding: "4px 8px",
                  borderRadius: 6,
                  border: "1px solid hsl(var(--border))",
                  background: "hsl(var(--card))",
                }}
                formatter={(value, name) => {
                  if (value === null || value === undefined) return ["—", String(name)];
                  return [formatRupeesCompact(Number(value)), String(name)];
                }}
              />
              <Legend
                wrapperStyle={{ fontSize: 11, paddingTop: 4 }}
                iconType="plainline"
                formatter={(value) => <span className="text-xs text-muted-foreground">{value}</span>}
              />
              <Line
                type="monotone"
                dataKey="sales"
                name="Sales"
                stroke="hsl(var(--primary))"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
                connectNulls={false}
              />
              <Line
                type="monotone"
                dataKey="purchases"
                name="Purchases"
                stroke="hsl(var(--info))"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
                connectNulls={false}
              />
              {forecast.kind === "forecast" ? (
                <Line
                  type="monotone"
                  dataKey="salesForecast"
                  name="Sales forecast"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  strokeDasharray="5 5"
                  strokeOpacity={0.55}
                  dot={false}
                  isAnimationActive={false}
                  connectNulls={false}
                />
              ) : null}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
      {forecast.kind === "actuals" || forecast.kind === "forecast" ? <p className="text-xs text-muted-foreground">{forecast.message}</p> : null}
    </div>
  );
}