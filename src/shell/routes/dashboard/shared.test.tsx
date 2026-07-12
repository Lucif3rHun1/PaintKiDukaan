import { render, screen } from "@testing-library/react";
import type React from "react";
import { describe, expect, it, vi } from "vitest";

import { DonutCard, TrendChartCard } from "../../../components/ui";

vi.mock("recharts", async () => {
  const actual = await vi.importActual<typeof import("recharts")>("recharts");
  return {
    ...actual,
    ResponsiveContainer: ({
      children,
      width,
      height,
    }: {
      children: React.ReactNode;
      width: number | string;
      height: number | string;
    }) => (
      <div
        data-testid="recharts-responsive-container"
        style={{ width: typeof width === "number" ? `${width}px` : width, height: typeof height === "number" ? `${height}px` : height }}
      >
        {children}
      </div>
    ),
  };
});

function withChartSize(node: React.ReactNode) {
  return <div style={{ width: 500, height: 100 }}>{node}</div>;
}

describe("dashboard shared charts", () => {
  it("renders stock donut segments with legend", () => {
    // Given: every stock state is present.
    render(
      <DonutCard
        segments={[
          { name: "Healthy", value: 10, colorClass: "bg-success", fill: "hsl(var(--success))" },
          { name: "Low", value: 2, colorClass: "bg-warning", fill: "hsl(var(--warning))" },
          { name: "Zero", value: 1, colorClass: "bg-destructive", fill: "hsl(var(--destructive))" },
          { name: "Negative", value: 1, colorClass: "bg-info", fill: "hsl(var(--info))" },
        ]}
      />,
    );

    // When: the donut and legend render.
    // Then: every legend row is present with its count.
    expect(screen.getByText("Healthy")).toBeInTheDocument();
    expect(screen.getByText("10")).toBeInTheDocument();
    expect(screen.getByText("Low")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("Zero")).toBeInTheDocument();
    expect(screen.getByText("Negative")).toBeInTheDocument();
  });

  it("drops zero-value segments from the donut", () => {
    // Given: a segment has zero value.
    const { container } = render(
      <DonutCard
        segments={[
          { name: "Healthy", value: 5, colorClass: "bg-success", fill: "hsl(var(--success))" },
          { name: "Zero", value: 0, colorClass: "bg-destructive", fill: "hsl(var(--destructive))" },
        ]}
      />,
    );

    // When: the donut renders.
    // Then: only the non-zero segment is present.
    expect(screen.getByText("Healthy")).toBeInTheDocument();
    expect(screen.queryByText("Zero")).not.toBeInTheDocument();
    expect(container.querySelectorAll("li")).toHaveLength(1);
  });

  it("renders guarded actual trend lines before forecast threshold", () => {
    // Given: enough history to show actual trend lines, but not enough to forecast.
    render(
      withChartSize(
        <TrendChartCard
          sales={[10000, 20000, 15000, 12000, 11000, 13000, 14000]}
          purchases={[5000, 8000, 7000, 6000, 5000, 4000, 3000]}
          labels={["2026-06-21", "2026-06-22", "2026-06-23", "2026-06-24", "2026-06-25", "2026-06-26", "2026-06-27"]}
        />,
      ),
    );

    // When: the trend chart renders.
    // Then: the summary line mentions both series and the forecast gate message is shown.
    expect(screen.getByText(/Sales ·/)).toBeInTheDocument();
    expect(screen.getByText(/Purchases/)).toBeInTheDocument();
    expect(screen.queryByText(/Sales forecast/)).not.toBeInTheDocument();
    expect(screen.getByText(/Forecast needs at least 14 daily points/)).toBeInTheDocument();
  });

  it("renders a forecast message once history is long enough", () => {
    // Given: enough regular sales history for forecast guardrails to pass.
    render(
      withChartSize(
        <TrendChartCard
          sales={Array.from({ length: 30 }, (_value, index) => 10000 + index * 2000)}
          purchases={Array.from({ length: 30 }, () => 5000)}
          labels={Array.from({ length: 30 }, (_value, index) => `2026-06-${String(index + 1).padStart(2, "0")}`)}
        />,
      ),
    );

    // When: the trend chart renders.
    // Then: a forecast message is shown alongside the summary line.
    expect(screen.getByText(/confidence forecast/)).toBeInTheDocument();
    expect(screen.getByText(/across 30 days/)).toBeInTheDocument();
  });

  it("returns null for empty data", () => {
    // Given: all series are empty.
    const { container } = render(<TrendChartCard sales={[]} purchases={[]} labels={[]} />);

    // When: the chart tries to render.
    // Then: nothing is rendered.
    expect(container.firstChild).toBeNull();
  });
});
