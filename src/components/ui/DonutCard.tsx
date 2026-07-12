import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";

export interface DonutSegment {
  /** Display name shown in legend and tooltip */
  name: string;
  /** Numeric value (count, amount, etc.) */
  value: number;
  /** Tailwind color class for the slice (e.g. "bg-success", "text-warning") */
  colorClass: string;
  /** Resolved CSS color for the Pie slice fill */
  fill: string;
}

export interface DonutCardProps {
  /** Segments to render. Zero-valued segments are dropped (no slice, no legend row). */
  segments: ReadonlyArray<Omit<DonutSegment, "fill"> & { fill?: string }>;
  /** Diameter in pixels. Default 96. */
  size?: number;
  /** Inner radius as a fraction of outer radius (0 = pie, 0.6 = thick donut). Default 0.6. */
  innerRadiusRatio?: number;
  /** Optional className for the outer flex container. */
  className?: string;
}

/**
 * Donut chart with side legend. Built on recharts for hover tooltips.
 * Segments with value <= 0 are skipped to keep the chart clean.
 */
export function DonutCard({ segments, size = 96, innerRadiusRatio = 0.6, className }: DonutCardProps) {
  const visible = segments.filter((s) => s.value > 0);
  const total = visible.reduce((acc, s) => acc + s.value, 0);
  const outerR = size / 2;
  const innerR = outerR * innerRadiusRatio;

  return (
    <div className={`flex items-center gap-4 ${className ?? ""}`}>
      <div style={{ width: size, height: size }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={visible as DonutSegment[]}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              innerRadius={innerR}
              outerRadius={outerR}
              strokeWidth={0}
              isAnimationActive={false}
            >
              {visible.map((s, i) => (
                <Cell key={i} fill={s.fill ?? "#94a3b8"} />
              ))}
            </Pie>
            <Tooltip
              formatter={(value, name) => {
                const n = typeof value === "number" ? value : Number(value) || 0;
                return [`${n} (${total > 0 ? Math.round((n / total) * 100) : 0}%)`, String(name)];
              }}
              contentStyle={{ fontSize: 12, padding: "4px 8px", borderRadius: 6, border: "1px solid #e5e7eb" }}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="space-y-1 text-sm">
        {visible.map((s) => (
          <li key={s.name} className="flex items-center gap-2">
            <span className={`inline-block h-2 w-2 rounded-full ${s.colorClass}`} aria-hidden="true" />
            <span className="flex-1 text-muted-foreground">{s.name}</span>
            <span className="tabular-nums font-medium">{s.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}