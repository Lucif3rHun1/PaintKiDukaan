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

  it("renders sales and purchase trend lines from uneven series", () => {
    // Given: sales and purchases cover different day counts.
    render(
      <TwoLineTrend
        sales={[10000, 20000, 15000]}
        purchases={[5000]}
        labels={["2026-06-25", "2026-06-26", "2026-06-27"]}
      />,
    );

    // When: the trend chart renders.
    const lines = document.querySelectorAll("polyline");

    // Then: both series are present and labelled for users.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toHaveClass("text-primary");
    expect(lines[1]).toHaveClass("text-info");
    expect(screen.getAllByText("Sales")).toHaveLength(2);
    expect(screen.getAllByText("Purchases")).toHaveLength(2);
    expect(screen.getByText("Net")).toBeInTheDocument();
    expect(screen.getByText("Avg/day")).toBeInTheDocument();
    expect(screen.getByText("25/06")).toBeInTheDocument();
    expect(screen.getByText("27/06")).toBeInTheDocument();
  });
});
