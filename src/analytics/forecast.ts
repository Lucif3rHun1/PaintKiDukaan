export interface DataPoint {
  readonly date: string;
  readonly value: number;
}

export type ForecastMethod = "movingAverage" | "linear" | "croston";
export type Confidence = "high" | "medium" | "low";

export interface ForecastPoint extends DataPoint {
  readonly lower: number;
  readonly upper: number;
  readonly isForecast: boolean;
}

export interface SeriesStats {
  readonly count: number;
  readonly mean: number;
  readonly zeroFraction: number;
  readonly maxZeroRun: number;
  readonly nonzeroCount: number;
  readonly averageNonzeroGap: number;
  readonly coefficientOfVariation: number;
}

export type ForecastResult =
  | { readonly kind: "insufficient"; readonly minPoints: number; readonly message: string }
  | { readonly kind: "actuals"; readonly points: readonly ForecastPoint[]; readonly message: string }
  | {
      readonly kind: "forecast";
      readonly method: ForecastMethod;
      readonly confidence: Confidence;
      readonly horizon: number;
      readonly points: readonly ForecastPoint[];
      readonly mae: number;
      readonly message: string;
    };

export const MIN_LINE_POINTS = 5;
export const MIN_FORECAST_POINTS = 14;
export const PREFERRED_FORECAST_POINTS = 30;

const ZERO_FRACTION_INTERMITTENT = 0.5;
const MAX_ZERO_RUN_INTERMITTENT = 7;
const MIN_R2_FOR_TREND = 0.25;

export function classifySeries(series: readonly DataPoint[]): SeriesStats {
  const count = series.length;
  const values = series.map((point) => Math.max(point.value, 0));
  const total = values.reduce((sum, value) => sum + value, 0);
  const mean = count > 0 ? total / count : 0;
  const zeroCount = values.filter((value) => value === 0).length;
  const nonzeroIndexes = values.flatMap((value, index) => (value > 0 ? [index] : []));

  let maxZeroRun = 0;
  let currentZeroRun = 0;
  for (const value of values) {
    if (value === 0) {
      currentZeroRun += 1;
      maxZeroRun = Math.max(maxZeroRun, currentZeroRun);
    } else {
      currentZeroRun = 0;
    }
  }

  const gaps = nonzeroIndexes.slice(1).map((index, gapIndex) => index - nonzeroIndexes[gapIndex]);
  const averageNonzeroGap = gaps.length > 0 ? average(gaps) : 0;
  const variance = count > 0 ? average(values.map((value) => (value - mean) ** 2)) : 0;
  const coefficientOfVariation = mean > 0 ? Math.sqrt(variance) / mean : 0;

  return {
    count,
    mean,
    zeroFraction: count > 0 ? zeroCount / count : 0,
    maxZeroRun,
    nonzeroCount: nonzeroIndexes.length,
    averageNonzeroGap,
    coefficientOfVariation,
  };
}

export function forecastDailySeries(series: readonly DataPoint[], maxHorizon = 7): ForecastResult {
  if (series.length < MIN_LINE_POINTS) {
    return { kind: "insufficient", minPoints: MIN_LINE_POINTS, message: "Trend needs at least 5 daily points." };
  }

  const actuals = toActualPoints(series);
  if (series.length < MIN_FORECAST_POINTS) {
    return { kind: "actuals", points: actuals, message: "Showing actuals only. Forecast needs at least 14 daily points." };
  }

  const stats = classifySeries(series);
  const intermittent =
    stats.zeroFraction >= ZERO_FRACTION_INTERMITTENT ||
    stats.maxZeroRun > MAX_ZERO_RUN_INTERMITTENT ||
    stats.averageNonzeroGap > MAX_ZERO_RUN_INTERMITTENT;

  if (intermittent && stats.nonzeroCount < MIN_FORECAST_POINTS) {
    return { kind: "actuals", points: actuals, message: "Sales are too intermittent for a safe forecast yet." };
  }

  const horizon = Math.min(maxHorizon, series.length >= 21 ? 7 : 3);
  const linear = fitLinear(series);
  const method: ForecastMethod = intermittent
    ? "croston"
    : series.length >= PREFERRED_FORECAST_POINTS && linear.r2 >= MIN_R2_FOR_TREND && Math.abs(linear.slope) >= stats.mean * 0.05
      ? "linear"
      : "movingAverage";
  const values = forecastValues(series, horizon, method, linear);
  const fitted = fittedValues(series, method, linear);
  const mae = meanAbsoluteError(series.map((point) => point.value), fitted);
  const points = [...actuals, ...toForecastPoints(series, values, mae)];
  const confidence = confidenceFrom(stats, mae);
  const methodLabel = method === "movingAverage" ? "moving average" : method === "linear" ? "linear trend" : "intermittent-demand";

  return {
    kind: "forecast",
    method,
    confidence,
    horizon,
    points,
    mae,
    message: `${confidence} confidence forecast using ${methodLabel}.`,
  };
}

function average(values: readonly number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function toActualPoints(series: readonly DataPoint[]): readonly ForecastPoint[] {
  return series.map((point) => ({ ...point, lower: point.value, upper: point.value, isForecast: false }));
}

function fitLinear(series: readonly DataPoint[]): { readonly slope: number; readonly intercept: number; readonly r2: number } {
  const values = series.map((point) => point.value);
  const xMean = (series.length - 1) / 2;
  const yMean = average(values);
  const numerator = values.reduce((sum, value, index) => sum + (index - xMean) * (value - yMean), 0);
  const denominator = values.reduce((sum, _value, index) => sum + (index - xMean) ** 2, 0) || 1;
  const slope = numerator / denominator;
  const intercept = yMean - slope * xMean;
  const residual = values.reduce((sum, value, index) => sum + (value - (intercept + slope * index)) ** 2, 0);
  const total = values.reduce((sum, value) => sum + (value - yMean) ** 2, 0) || 1;
  return { slope, intercept, r2: Math.max(0, 1 - residual / total) };
}

function forecastValues(
  series: readonly DataPoint[],
  horizon: number,
  method: ForecastMethod,
  linear: { readonly slope: number; readonly intercept: number },
): readonly number[] {
  if (method === "linear") {
    return Array.from({ length: horizon }, (_value, index) => Math.max(0, Math.round(linear.intercept + linear.slope * (series.length + index))));
  }
  if (method === "croston") {
    return Array.from({ length: horizon }, () => Math.round(crostonEstimate(series)));
  }
  const window = series.slice(-Math.min(7, series.length));
  const estimate = Math.round(average(window.map((point) => point.value)));
  return Array.from({ length: horizon }, () => estimate);
}

function fittedValues(
  series: readonly DataPoint[],
  method: ForecastMethod,
  linear: { readonly slope: number; readonly intercept: number },
): readonly number[] {
  if (method === "linear") {
    return series.map((_point, index) => Math.max(0, Math.round(linear.intercept + linear.slope * index)));
  }
  if (method === "croston") {
    const estimate = crostonEstimate(series);
    return series.map(() => estimate);
  }
  return series.map((_point, index) => {
    const start = Math.max(0, index - 6);
    const window = series.slice(start, index + 1);
    return average(window.map((point) => point.value));
  });
}

function crostonEstimate(series: readonly DataPoint[]): number {
  const nonzero = series.flatMap((point, index) => (point.value > 0 ? [{ index, value: point.value }] : []));
  const gaps = nonzero.slice(1).map((point, index) => point.index - nonzero[index].index);
  const averageGap = gaps.length > 0 ? average(gaps) : 1;
  return average(nonzero.map((point) => point.value)) / Math.max(1, averageGap);
}

function meanAbsoluteError(actuals: readonly number[], fitted: readonly number[]): number {
  if (actuals.length === 0 || fitted.length === 0) return 0;
  return average(actuals.map((actual, index) => Math.abs(actual - (fitted[index] ?? actual))));
}

function toForecastPoints(series: readonly DataPoint[], values: readonly number[], mae: number): readonly ForecastPoint[] {
  const last = series[series.length - 1];
  if (!last) return [];
  return values.map((value, index) => {
    const date = addDays(last.date, index + 1);
    return { date, value, lower: Math.max(0, Math.round(value - mae)), upper: Math.round(value + mae), isForecast: true };
  });
}

function addDays(date: string, days: number): string {
  // Parse as local date to avoid UTC timezone shift (e.g. IST midnight → prev day UTC)
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y, m - 1, d + days);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function confidenceFrom(stats: SeriesStats, mae: number): Confidence {
  if (stats.mean <= 0) return "low";
  const relativeError = mae / stats.mean;
  if (stats.count >= PREFERRED_FORECAST_POINTS && relativeError <= 0.2) return "high";
  if (stats.count >= 20 && relativeError <= 0.4) return "medium";
  return "low";
}
