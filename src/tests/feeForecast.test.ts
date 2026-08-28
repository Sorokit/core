import { describe, it, expect, beforeEach } from "vitest";
import {
  clearFeeObservations,
  evaluateForecastAccuracy,
  forecastFees,
  getFeeObservations,
  normalizeFeeHistory,
  recordFeeObservation,
  linearFeeForecastModel,
  DEFAULT_FORECAST_CONFIDENCE_LEVEL,
  FEE_OBSERVATION_MAX_ENTRIES,
  type FeeForecastModel,
  type FeeObservation,
} from "../transaction/feeForecast";

const DAY = 86_400_000;
const START = Date.parse("2026-01-01T00:00:00.000Z");

/** Build a series of observations one day apart, starting at START. */
function series(fees: number[], startAt = START): FeeObservation[] {
  return fees.map((feeStroops, i) => ({
    timestamp: startAt + i * DAY,
    feeStroops,
  }));
}

describe("normalizeFeeHistory", () => {
  it("sorts observations ascending by timestamp", () => {
    const result = normalizeFeeHistory([
      { timestamp: START + 2 * DAY, feeStroops: 300 },
      { timestamp: START, feeStroops: 100 },
      { timestamp: START + DAY, feeStroops: 200 },
    ]);

    expect(result.observations.map((o) => o.feeStroops)).toEqual([
      100, 200, 300,
    ]);
    expect(result.discarded).toHaveLength(0);
  });

  it("accepts ISO-8601 timestamps and normalises them to epoch ms", () => {
    const result = normalizeFeeHistory([
      { timestamp: "2026-01-01T00:00:00.000Z", feeStroops: 100 },
    ]);

    expect(result.observations[0]?.timestamp).toBe(START);
  });

  it("discards observations with unparseable timestamps", () => {
    const result = normalizeFeeHistory([
      { timestamp: "not-a-date", feeStroops: 100 },
      { timestamp: Number.NaN, feeStroops: 100 },
      { timestamp: START, feeStroops: 100 },
    ]);

    expect(result.observations).toHaveLength(1);
    expect(result.discarded).toHaveLength(2);
    expect(result.discarded.every((d) => d.reason === "invalid_timestamp")).toBe(
      true,
    );
  });

  it("discards observations with negative or non-finite fees", () => {
    const result = normalizeFeeHistory([
      { timestamp: START, feeStroops: -5 },
      { timestamp: START + DAY, feeStroops: Number.POSITIVE_INFINITY },
      { timestamp: START + 2 * DAY, feeStroops: 100 },
    ]);

    expect(result.observations).toHaveLength(1);
    expect(result.discarded.map((d) => d.reason)).toEqual([
      "invalid_fee",
      "invalid_fee",
    ]);
  });

  it("removes extreme outliers using a modified z-score", () => {
    const observations = series([
      100, 102, 98, 101, 99, 100, 103, 97, 1_000_000, 101,
    ]);

    const result = normalizeFeeHistory(observations);

    expect(result.observations.map((o) => o.feeStroops)).not.toContain(
      1_000_000,
    );
    expect(result.discarded).toHaveLength(1);
    expect(result.discarded[0]?.reason).toBe("outlier");
  });

  it("keeps outliers when the threshold is disabled", () => {
    const observations = series([100, 102, 98, 101, 1_000_000]);

    const result = normalizeFeeHistory(observations, {
      outlierThreshold: null,
    });

    expect(result.observations).toHaveLength(5);
    expect(result.discarded).toHaveLength(0);
  });

  it("does not flag every value as an outlier when the MAD is zero", () => {
    // A degenerate distribution: scoring against a zero MAD would divide by
    // zero and discard everything that is not exactly the median.
    const observations = series([100, 100, 100, 100, 250]);

    const result = normalizeFeeHistory(observations);

    expect(result.observations).toHaveLength(5);
    expect(result.discarded).toHaveLength(0);
  });
});

describe("forecastFees", () => {
  it("projects a rising trend forward and reports the trend per day", () => {
    const observations = series([100, 110, 120, 130, 140]);

    const result = forecastFees(3, { observations });

    expect(result.available).toBe(true);
    if (!result.available) return;
    // Perfectly linear +10/day, so 3 days past the last point (140) is 170.
    expect(result.forecast.predictedFeeStroops).toBeCloseTo(170, 6);
    expect(result.forecast.trendPerDayStroops).toBeCloseTo(10, 6);
    expect(result.forecast.daysAhead).toBe(3);
  });

  it("returns a confidence range that brackets the prediction", () => {
    const observations = series([100, 130, 115, 160, 140, 175]);

    const result = forecastFees(2, { observations });

    expect(result.available).toBe(true);
    if (!result.available) return;
    const { lowerBoundStroops, predictedFeeStroops, upperBoundStroops } =
      result.forecast;
    expect(lowerBoundStroops).toBeLessThanOrEqual(predictedFeeStroops);
    expect(upperBoundStroops).toBeGreaterThanOrEqual(predictedFeeStroops);
    expect(result.forecast.confidenceLevel).toBe(
      DEFAULT_FORECAST_CONFIDENCE_LEVEL,
    );
  });

  it("never returns a negative fee or lower bound", () => {
    // A steep downward trend projected far ahead would go negative unclamped.
    const observations = series([500, 400, 300, 200, 100]);

    const result = forecastFees(30, { observations });

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.forecast.predictedFeeStroops).toBeGreaterThanOrEqual(0);
    expect(result.forecast.lowerBoundStroops).toBeGreaterThanOrEqual(0);
  });

  it("widens the confidence range for volatile data", () => {
    const stable = series([100, 101, 100, 101, 100, 101, 100, 101]);
    const volatile = series([100, 400, 60, 350, 90, 300, 120, 380]);

    const stableResult = forecastFees(5, {
      observations: stable,
      normalize: { outlierThreshold: null },
    });
    const volatileResult = forecastFees(5, {
      observations: volatile,
      normalize: { outlierThreshold: null },
    });

    expect(stableResult.available).toBe(true);
    expect(volatileResult.available).toBe(true);
    if (!stableResult.available || !volatileResult.available) return;

    const stableWidth =
      stableResult.forecast.upperBoundStroops -
      stableResult.forecast.lowerBoundStroops;
    const volatileWidth =
      volatileResult.forecast.upperBoundStroops -
      volatileResult.forecast.lowerBoundStroops;

    expect(volatileWidth).toBeGreaterThan(stableWidth);
    expect(volatileResult.forecast.volatilityStroops).toBeGreaterThan(
      stableResult.forecast.volatilityStroops,
    );
  });

  it("reports insufficient data explicitly instead of guessing", () => {
    const result = forecastFees(1, { observations: series([100, 110]) });

    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.reason).toBe("insufficient_data");
    expect(result.message).toContain("requires at least 3");
    expect(result.dataWindow.observationCount).toBe(2);
  });

  it("reports insufficient data when the history is empty", () => {
    const result = forecastFees(1, { observations: [] });

    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.reason).toBe("insufficient_data");
    expect(result.dataWindow.observationCount).toBe(0);
    expect(result.dataWindow.startTimestamp).toBeNull();
    expect(result.dataWindow.endTimestamp).toBeNull();
  });

  it("rejects a negative or non-finite daysAhead", () => {
    const observations = series([100, 110, 120]);

    const negative = forecastFees(-1, { observations });
    const nan = forecastFees(Number.NaN, { observations });

    expect(negative.available).toBe(false);
    expect(nan.available).toBe(false);
    if (negative.available) return;
    expect(negative.reason).toBe("invalid_days_ahead");
  });

  it("exposes the data window the forecast was derived from", () => {
    const observations = series([100, 110, 120, 130, 1_000_000]);

    const result = forecastFees(1, { observations });

    expect(result.available).toBe(true);
    if (!result.available) return;
    const { dataWindow } = result.forecast;
    expect(dataWindow.observationCount).toBe(4);
    expect(dataWindow.discardedCount).toBe(1);
    expect(dataWindow.startTimestamp).toBe(START);
    expect(dataWindow.endTimestamp).toBe(START + 3 * DAY);
    expect(dataWindow.spanDays).toBeCloseTo(3, 6);
  });

  it("handles missing observations by forecasting over the surviving window", () => {
    // Gaps in the series plus malformed entries that must not break the fit.
    const observations: FeeObservation[] = [
      { timestamp: START, feeStroops: 100 },
      { timestamp: "not-a-date", feeStroops: 105 },
      { timestamp: START + 3 * DAY, feeStroops: 130 },
      { timestamp: START + 4 * DAY, feeStroops: -1 },
      { timestamp: START + 7 * DAY, feeStroops: 170 },
      { timestamp: START + 10 * DAY, feeStroops: 200 },
    ];

    const result = forecastFees(2, { observations });

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.forecast.dataWindow.observationCount).toBe(4);
    expect(result.forecast.dataWindow.discardedCount).toBe(2);
    expect(result.forecast.predictedFeeStroops).toBeGreaterThan(200);
  });

  it("falls back to a flat projection when all observations share a timestamp", () => {
    const observations: FeeObservation[] = [
      { timestamp: START, feeStroops: 100 },
      { timestamp: START, feeStroops: 120 },
      { timestamp: START, feeStroops: 110 },
    ];

    const result = forecastFees(5, { observations });

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.forecast.trendPerDayStroops).toBe(0);
    expect(result.forecast.predictedFeeStroops).toBeCloseTo(110, 6);
  });

  it("accepts a replacement model without changing the public API", () => {
    const constantModel: FeeForecastModel = {
      name: "constant",
      minObservations: 1,
      forecast: () => ({
        predictedFeeStroops: 42,
        lowerBoundStroops: 40,
        upperBoundStroops: 44,
        trendPerDayStroops: 0,
        volatilityStroops: 0,
      }),
    };

    const result = forecastFees(7, {
      observations: series([100]),
      model: constantModel,
    });

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.forecast.model).toBe("constant");
    expect(result.forecast.predictedFeeStroops).toBe(42);
  });

  it("reports the replacement model's own minimum in the shortfall message", () => {
    const hungryModel: FeeForecastModel = {
      name: "hungry",
      minObservations: 50,
      forecast: () => ({
        predictedFeeStroops: 0,
        lowerBoundStroops: 0,
        upperBoundStroops: 0,
        trendPerDayStroops: 0,
        volatilityStroops: 0,
      }),
    };

    const result = forecastFees(1, {
      observations: series([100, 110, 120]),
      model: hungryModel,
    });

    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.message).toContain("requires at least 50");
  });

  it("widens the range as the forecast reaches further ahead", () => {
    const observations = series([100, 130, 115, 160, 140, 175]);

    const near = forecastFees(1, { observations });
    const far = forecastFees(60, { observations });

    expect(near.available && far.available).toBe(true);
    if (!near.available || !far.available) return;

    const nearWidth =
      near.forecast.upperBoundStroops - near.forecast.lowerBoundStroops;
    const farWidth =
      far.forecast.upperBoundStroops - far.forecast.lowerBoundStroops;
    expect(farWidth).toBeGreaterThan(nearWidth);
  });
});

describe("fee observation collection", () => {
  beforeEach(() => {
    clearFeeObservations();
  });

  it("collects observations and forecasts from the store by default", () => {
    for (const observation of series([100, 110, 120, 130])) {
      recordFeeObservation(observation, "test-net");
    }

    expect(getFeeObservations("test-net")).toHaveLength(4);

    const result = forecastFees(1, { networkPassphrase: "test-net" });

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.forecast.predictedFeeStroops).toBeCloseTo(140, 6);
  });

  it("keeps observations sorted even when recorded out of order", () => {
    recordFeeObservation({ timestamp: START + 2 * DAY, feeStroops: 300 });
    recordFeeObservation({ timestamp: START, feeStroops: 100 });
    recordFeeObservation({ timestamp: START + DAY, feeStroops: 200 });

    expect(getFeeObservations().map((o) => o.feeStroops)).toEqual([
      100, 200, 300,
    ]);
  });

  it("ignores malformed observations without throwing", () => {
    recordFeeObservation({ timestamp: "nope", feeStroops: 100 });
    recordFeeObservation({ timestamp: START, feeStroops: -1 });
    recordFeeObservation({ timestamp: START, feeStroops: Number.NaN });

    expect(getFeeObservations()).toHaveLength(0);
  });

  it("bounds the store and evicts the oldest observations first", () => {
    const total = FEE_OBSERVATION_MAX_ENTRIES + 10;
    for (let i = 0; i < total; i += 1) {
      recordFeeObservation({ timestamp: START + i * DAY, feeStroops: i });
    }

    const stored = getFeeObservations();
    expect(stored).toHaveLength(FEE_OBSERVATION_MAX_ENTRIES);
    expect(stored[0]?.feeStroops).toBe(10);
  });

  it("isolates observations per network", () => {
    recordFeeObservation({ timestamp: START, feeStroops: 100 }, "a");
    recordFeeObservation({ timestamp: START, feeStroops: 200 }, "b");

    expect(getFeeObservations("a")).toHaveLength(1);
    expect(getFeeObservations("b")).toHaveLength(1);

    clearFeeObservations("a");

    expect(getFeeObservations("a")).toHaveLength(0);
    expect(getFeeObservations("b")).toHaveLength(1);
  });

  it("returns a copy so callers cannot mutate the store", () => {
    recordFeeObservation({ timestamp: START, feeStroops: 100 });

    const copy = getFeeObservations();
    copy.push({ timestamp: START + DAY, feeStroops: 999 });

    expect(getFeeObservations()).toHaveLength(1);
  });

  it("records observations synchronously without performing I/O", () => {
    // Recording must never block or defer transaction work; the call returns
    // void and completes in the same tick.
    const before = getFeeObservations("sync-check").length;
    const returned = recordFeeObservation(
      { timestamp: START, feeStroops: 100 },
      "sync-check",
    );

    expect(returned).toBeUndefined();
    expect(getFeeObservations("sync-check")).toHaveLength(before + 1);
  });
});

describe("evaluateForecastAccuracy", () => {
  it("scores a perfectly linear dataset with near-zero error", () => {
    const history = series([100, 110, 120, 130, 140, 150, 160, 170]);

    const report = evaluateForecastAccuracy(history);

    expect(report.sampleCount).toBeGreaterThan(0);
    expect(report.meanAbsoluteErrorStroops).toBeLessThan(1);
    expect(report.meanAbsolutePercentageError).toBeLessThan(0.01);
    expect(report.rootMeanSquaredErrorStroops).toBeLessThan(1);
  });

  it("reports higher error for an unpredictable dataset", () => {
    const linear = series([100, 110, 120, 130, 140, 150, 160, 170]);
    const erratic = series([100, 900, 120, 40, 700, 150, 30, 800]);

    const linearReport = evaluateForecastAccuracy(linear);
    const erraticReport = evaluateForecastAccuracy(erratic, {
      normalize: { outlierThreshold: null },
    });

    expect(erraticReport.meanAbsoluteErrorStroops).toBeGreaterThan(
      linearReport.meanAbsoluteErrorStroops,
    );
  });

  it("reports confidence range coverage", () => {
    const history = series([100, 110, 120, 130, 140, 150, 160, 170]);

    const report = evaluateForecastAccuracy(history);

    expect(report.confidenceRangeCoverage).toBeGreaterThanOrEqual(0);
    expect(report.confidenceRangeCoverage).toBeLessThanOrEqual(1);
    expect(report.samples).toHaveLength(report.sampleCount);
  });

  it("returns a zeroed report when the dataset is too small to score", () => {
    const report = evaluateForecastAccuracy(series([100, 110]));

    expect(report.sampleCount).toBe(0);
    expect(report.meanAbsoluteErrorStroops).toBe(0);
    expect(report.confidenceRangeCoverage).toBe(0);
    expect(report.samples).toEqual([]);
  });

  it("excludes zero actuals from percentage error instead of returning Infinity", () => {
    const history = series([100, 110, 120, 0, 0, 0]);

    const report = evaluateForecastAccuracy(history, {
      normalize: { outlierThreshold: null },
    });

    expect(Number.isFinite(report.meanAbsolutePercentageError)).toBe(true);
  });

  it("honours a custom warmup size", () => {
    const history = series([100, 110, 120, 130, 140, 150, 160, 170]);

    const small = evaluateForecastAccuracy(history, { warmupSize: 3 });
    const large = evaluateForecastAccuracy(history, { warmupSize: 6 });

    expect(small.sampleCount).toBeGreaterThan(large.sampleCount);
  });
});

describe("linearFeeForecastModel", () => {
  it("declares the minimum observations it needs", () => {
    expect(linearFeeForecastModel.name).toBe("linear-regression");
    expect(linearFeeForecastModel.minObservations).toBe(3);
  });

  it("scales the confidence range by the published z-value for the level", () => {
    // Residual-driven margins are proportional to z, so the ratio of two range
    // widths on identical data must match the ratio of the z-values:
    // z(0.99)/z(0.95) = 2.5758 / 1.9600 = 1.3142.
    const observations = series([100, 130, 115, 160, 140, 175]);

    const at95 = forecastFees(1, { observations, confidenceLevel: 0.95 });
    const at99 = forecastFees(1, { observations, confidenceLevel: 0.99 });

    expect(at95.available && at99.available).toBe(true);
    if (!at95.available || !at99.available) return;

    const width95 =
      at95.forecast.upperBoundStroops - at95.forecast.lowerBoundStroops;
    const width99 =
      at99.forecast.upperBoundStroops - at99.forecast.lowerBoundStroops;

    expect(width99 / width95).toBeCloseTo(2.5758 / 1.96, 3);
  });
});
