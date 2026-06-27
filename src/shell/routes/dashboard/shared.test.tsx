import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Donut, TwoLineTrend } from "./shared";

describe("dashboard shared charts", () => {
  it("renders stock donut states with distinct visual classes", () => {
    // Given: every stock state is present.
    render(<Donut healthy={10} low={2} zero={1} negative={1} />);

    // When: the donut and legend render.
    const circles = document.querySelectorAll("circle");

    // Then: low, zero, and negative are visually distinguishable.
    expect(circles[1]).toHaveClass("stroke-success");
    expect(circles[2]).toHaveClass("stroke-warning");
    expect(circles[3]).toHaveClass("stroke-destructive");
    expect(circles[4]).toHaveClass("stroke-info");
    expect(screen.getByText("Low").previousSibling).toHaveClass("bg-warning");
    expect(screen.getByText("Zero").previousSibling).toHaveClass("bg-destructive");
    expect(screen.getByText("Negative").previousSibling).toHaveClass("bg-info");
  });

  it("renders guarded actual trend lines before forecast threshold", () => {
    // Given: enough history to show actual trend lines, but not enough to forecast.
    render(
      <TwoLineTrend
        sales={[10000, 20000, 15000, 12000, 11000, 13000, 14000]}
        purchases={[5000, 8000, 7000, 6000, 5000, 4000, 3000]}
        labels={["2026-06-21", "2026-06-22", "2026-06-23", "2026-06-24", "2026-06-25", "2026-06-26", "2026-06-27"]}
      />,
    );

    // When: the trend chart renders.
    const lines = document.querySelectorAll("polyline");

    // Then: both actual series are present and forecast remains gated.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toHaveClass("text-primary");
    expect(lines[1]).toHaveClass("text-info");
    expect(screen.getAllByText("Sales")).toHaveLength(1);
    expect(screen.getAllByText("Purchases")).toHaveLength(1);
    expect(screen.getByText(/Forecast needs at least 14 daily points/)).toBeInTheDocument();
    expect(screen.getByText("21/06")).toBeInTheDocument();
    expect(screen.getByText("27/06")).toBeInTheDocument();
  });

  it("renders a dashed forecast only after enough daily history", () => {
    // Given: enough regular sales history for forecast guardrails to pass.
    render(
      <TwoLineTrend
        sales={Array.from({ length: 30 }, (_value, index) => 10000 + index * 2000)}
        purchases={Array.from({ length: 30 }, () => 5000)}
        labels={Array.from({ length: 30 }, (_value, index) => `2026-06-${String(index + 1).padStart(2, "0")}`)}
      />,
    );

    // When: the trend chart renders.
    const lines = document.querySelectorAll("polyline");

    // Then: actual sales, actual purchases, and dashed forecast are separate.
    expect(lines).toHaveLength(3);
    expect(lines[2]).toHaveAttribute("stroke-dasharray", "5 5");
    expect(screen.getByText("Sales forecast")).toBeInTheDocument();
    expect(screen.getByText(/confidence forecast/)).toBeInTheDocument();
  });
});
