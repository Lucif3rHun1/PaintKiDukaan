import { describe, expect, it } from "vitest";

import { classifySeries, forecastDailySeries, MIN_LINE_POINTS } from "./forecast";

function points(values: readonly number[]) {
  return values.map((value, index) => ({ date: `2026-06-${String(index + 1).padStart(2, "0")}`, value }));
}

describe("forecastDailySeries", () => {
  it("blocks trend charts when fewer than five daily points exist", () => {
    // Given: only four daily values.
    const series = points([100, 120, 80, 90]);

    // When: a forecast is requested.
    const result = forecastDailySeries(series);

    // Then: the chart is explicitly gated.
    expect(result).toEqual({ kind: "insufficient", minPoints: MIN_LINE_POINTS, message: "Trend needs at least 5 daily points." });
  });

  it("shows actuals only before the forecast threshold", () => {
    // Given: seven dense daily values.
    const series = points([100, 110, 120, 130, 140, 150, 160]);

    // When: a forecast is requested.
    const result = forecastDailySeries(series);

    // Then: actuals render but future values stay hidden.
    expect(result.kind).toBe("actuals");
    if (result.kind === "actuals") {
      expect(result.points).toHaveLength(7);
      expect(result.message).toContain("Forecast needs at least 14 daily points");
    }
  });

  it("uses moving average for regular demand without a strong trend", () => {
    // Given: enough stable sales history.
    const series = points(Array.from({ length: 21 }, (_value, index) => 1000 + (index % 3) * 50));

    // When: a forecast is requested.
    const result = forecastDailySeries(series);

    // Then: the conservative moving average method is used.
    expect(result.kind).toBe("forecast");
    if (result.kind === "forecast") {
      expect(result.method).toBe("movingAverage");
      expect(result.horizon).toBe(7);
      expect(result.points.filter((point) => point.isForecast)).toHaveLength(7);
    }
  });

  it("uses linear trend when enough history has a strong direction", () => {
    // Given: thirty days of steadily rising sales.
    const series = points(Array.from({ length: 30 }, (_value, index) => 1000 + index * 200));

    // When: a forecast is requested.
    const result = forecastDailySeries(series);

    // Then: the trend method is allowed.
    expect(result.kind).toBe("forecast");
    if (result.kind === "forecast") {
      expect(result.method).toBe("linear");
      expect(result.points.filter((point) => point.isForecast)[0]?.value).toBeGreaterThan(6800);
    }
  });

  it("keeps sparse intermittent demand as actuals until enough nonzero events exist", () => {
    // Given: mostly zero sales with too few demand events.
    const series = points([0, 0, 500, 0, 0, 0, 700, 0, 0, 0, 0, 900, 0, 0]);

    // When: a forecast is requested.
    const result = forecastDailySeries(series);

    // Then: the forecast is not faked.
    expect(result.kind).toBe("actuals");
    if (result.kind === "actuals") {
      expect(result.message).toContain("too intermittent");
    }
  });
});

describe("classifySeries", () => {
  it("reports zero-heavy demand shape", () => {
    // Given: an intermittent demand series.
    const series = points([0, 0, 10, 0, 20, 0, 0, 0]);

    // When: the shape is classified.
    const stats = classifySeries(series);

    // Then: sparse demand characteristics are visible to callers.
    expect(stats.count).toBe(8);
    expect(stats.nonzeroCount).toBe(2);
    expect(stats.zeroFraction).toBe(0.75);
    expect(stats.maxZeroRun).toBe(3);
  });
});
