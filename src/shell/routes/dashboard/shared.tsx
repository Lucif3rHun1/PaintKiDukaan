import { type ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { Money, Skeleton } from "../../../components/ui";

export function cnTone(...c: string[]): string {
  return c.filter(Boolean).join(" ");
}

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

interface SparklineProps {
  data: number[];
  tone: string;
}

export function Sparkline({ data, tone }: SparklineProps) {
  if (data.length < 2) return null;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const width = 96;
  const height = 28;
  const points = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * width;
      const y = height - ((v - min) / range) * height;
      return `${x},${y}`;
    })
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={cnTone("h-7 w-24", tone)}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
    </svg>
  );
}

interface TwoLineTrendProps {
  sales: number[];
  purchases: number[];
}

export function TwoLineTrend({ sales, purchases }: TwoLineTrendProps) {
  if (sales.length < 2 && purchases.length < 2) return null;
  const len = Math.max(sales.length, purchases.length, 2);
  const series = [
    sales.length < len ? [...sales, ...Array(len - sales.length).fill(0)] : sales,
    purchases.length < len ? [...purchases, ...Array(len - purchases.length).fill(0)] : purchases,
  ];
  const all = [...series[0], ...series[1]];
  const max = Math.max(...all, 1);
  const min = Math.min(...all, 0);
  const range = max - min || 1;
  const width = 240;
  const height = 64;
  const toPoints = (data: number[]) =>
    data
      .map((v, i) => {
        const x = (i / (len - 1)) * width;
        const y = height - ((v - min) / range) * height;
        return `${x},${y}`;
      })
      .join(" ");
  return (
    <div className="space-y-2">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-16 w-full"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <polyline
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          points={toPoints(series[0])}
          className="text-primary"
        />
        <polyline
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          points={toPoints(series[1])}
          className="text-info"
        />
      </svg>
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-3 rounded-sm bg-primary" />
          Sales
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-3 rounded-sm bg-info" />
          Purchases
        </span>
      </div>
    </div>
  );
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
    { len: zeroLen, color: "stroke-warning" },
    { len: negativeLen, color: "stroke-destructive" },
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
        <LegendDot color="bg-warning" label="Zero" count={zero} />
        <LegendDot color="bg-destructive" label="Negative" count={negative} />
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

interface DeltaProps {
  value: number;
  prefix: string;
  absolute?: boolean;
  loading?: boolean;
}

export function Delta({ value, prefix, absolute, loading }: DeltaProps) {
  if (loading) return <Skeleton className="h-4 w-24" />;
  const isPositive = value >= 0;
  const display = absolute ? Math.abs(value) : value;
  const Icon = isPositive ? ArrowUpRight : ArrowDownRight;
  const tone = isPositive ? "text-success" : "text-destructive";
  return (
    <span className={cnTone("flex items-center gap-1 text-xs", tone)}>
      <Icon className="h-3 w-3" />
      {absolute ? display : <Money paise={display} compact />}
      <span className="text-muted-foreground">{prefix}</span>
    </span>
  );
}
