/**
 * Historical transaction fee forecasting (#523).
 *
 * Collects normalised historical fee observations, derives trend and
 * volatility, and projects future fees with a confidence range.
 *
 * The prediction strategy is pluggable via {@link FeeForecastModel} so a more
 * sophisticated model can replace the default linear-regression estimator
 * without changing the public SDK API.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/** A raw fee observation as supplied by a caller or collector. */
export interface FeeObservation {
  /** Observation time — epoch milliseconds, or an ISO-8601 timestamp. */
  timestamp: number | string;
  /** Observed fee in stroops. */
  feeStroops: number;
}

/** A validated, time-sorted fee observation. */
export interface NormalizedFeeObservation {
  /** Observation time as epoch milliseconds. */
  timestamp: number;
  /** Observed fee in stroops. */
  feeStroops: number;
}

/** Why an observation was discarded during normalisation. */
export type DiscardedObservationReason =
  | "invalid_timestamp"
  | "invalid_fee"
  | "outlier";

/** An observation that did not survive normalisation. */
export interface DiscardedObservation {
  /** The observation as originally supplied. */
  observation: FeeObservation;
  reason: DiscardedObservationReason;
}

/** Result of normalising a batch of raw observations. */
export interface NormalizedFeeHistory {
  /** Usable observations, ascending by timestamp. */
  observations: NormalizedFeeObservation[];
  /** Observations that were rejected, with the reason for each. */
  discarded: DiscardedObservation[];
}

/** Options controlling how raw observations are normalised. */
export interface NormalizeFeeHistoryOptions {
  /**
   * Modified z-score above which an observation is treated as an outlier.
   * Set to `null` to disable outlier removal. Default: 3.5.
   */
  outlierThreshold?: number | null;
}

/** The window of historical data a forecast was derived from. */
export interface ForecastDataWindow {
  /** Number of observations used. */
  observationCount: number;
  /** Earliest observation timestamp used (epoch ms), or null when empty. */
  startTimestamp: number | null;
  /** Latest observation timestamp used (epoch ms), or null when empty. */
  endTimestamp: number | null;
  /** Span between first and last observation in days. */
  spanDays: number;
  /** Observations discarded as outliers or malformed before forecasting. */
  discardedCount: number;
}

/** A fee forecast for a single point in the future. */
export interface FeeForecast {
  /** How many days ahead this forecast projects. */
  daysAhead: number;
  /** Predicted fee in stroops, clamped to be non-negative. */
  predictedFeeStroops: number;
  /** Lower bound of the confidence range, in stroops. */
  lowerBoundStroops: number;
  /** Upper bound of the confidence range, in stroops. */
  upperBoundStroops: number;
  /** Confidence level the range represents, e.g. 0.95. */
  confidenceLevel: number;
  /** Fee change per day implied by the fitted trend, in stroops. */
  trendPerDayStroops: number;
  /** Standard deviation of the historical observations, in stroops. */
  volatilityStroops: number;
  /** The historical window the forecast was derived from. */
  dataWindow: ForecastDataWindow;
  /** Name of the model that produced the forecast. */
  model: string;
}

/** Reason a forecast could not be produced. */
export type ForecastUnavailableReason =
  | "insufficient_data"
  | "invalid_days_ahead";

/**
 * The outcome of a forecast request.
 *
 * Insufficient history is reported explicitly rather than by throwing or by
 * returning a silently degraded number.
 */
export type FeeForecastResult =
  | { available: true; forecast: FeeForecast }
  | {
      available: false;
      reason: ForecastUnavailableReason;
      /** Human-readable explanation of what is missing. */
      message: string;
      /** The window that *was* available, for diagnostics. */
      dataWindow: ForecastDataWindow;
    };

/**
 * A pluggable forecasting strategy.
 *
 * Implementations receive already-normalised, ascending observations and are
 * responsible only for producing the prediction and its confidence range.
 */
export interface FeeForecastModel {
  /** Identifier recorded on {@link FeeForecast.model}. */
  readonly name: string;
  /** Minimum number of observations the model needs to produce a forecast. */
  readonly minObservations: number;
  /**
   * Produce a forecast from normalised history.
   *
   * @param observations - Ascending, validated observations.
   * @param daysAhead    - How far ahead to project.
   * @param confidenceLevel - Requested confidence level, e.g. 0.95.
   */
  forecast(
    observations: NormalizedFeeObservation[],
    daysAhead: number,
    confidenceLevel: number,
  ): FeeForecastPrediction;
}

/** The raw prediction a {@link FeeForecastModel} returns. */
export interface FeeForecastPrediction {
  predictedFeeStroops: number;
  lowerBoundStroops: number;
  upperBoundStroops: number;
  trendPerDayStroops: number;
  volatilityStroops: number;
}

/** Options for {@link forecastFees}. */
export interface ForecastFeesOptions {
  /** Observations to forecast from. Defaults to the collected store. */
  observations?: FeeObservation[];
  /** Network key for the collected store. Default: "default". */
  networkPassphrase?: string;
  /** Confidence level for the returned range, between 0 and 1. Default: 0.95. */
  confidenceLevel?: number;
  /** Forecasting strategy. Default: {@link linearFeeForecastModel}. */
  model?: FeeForecastModel;
  /** Normalisation options applied before forecasting. */
  normalize?: NormalizeFeeHistoryOptions;
}

/** A forecast paired with the fee actually observed, for accuracy scoring. */
export interface ForecastAccuracySample {
  predictedFeeStroops: number;
  actualFeeStroops: number;
  /** Whether the actual fee fell inside the predicted confidence range. */
  withinConfidenceRange: boolean;
}

/** Aggregate accuracy of a model over a historical test dataset. */
export interface ForecastAccuracyReport {
  /** Number of forecasts scored. */
  sampleCount: number;
  /** Mean absolute error in stroops. */
  meanAbsoluteErrorStroops: number;
  /** Mean absolute percentage error, as a fraction (0.1 = 10%). */
  meanAbsolutePercentageError: number;
  /** Root-mean-square error in stroops. */
  rootMeanSquaredErrorStroops: number;
  /** Fraction of actuals that fell inside the predicted confidence range. */
  confidenceRangeCoverage: number;
  /** Per-sample detail. */
  samples: ForecastAccuracySample[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Default modified z-score above which an observation is an outlier. */
export const DEFAULT_OUTLIER_THRESHOLD = 3.5;

/** Default confidence level applied to forecast ranges. */
export const DEFAULT_FORECAST_CONFIDENCE_LEVEL = 0.95;

/** Maximum observations retained per network by the built-in collector. */
export const FEE_OBSERVATION_MAX_ENTRIES = 500;

const MS_PER_DAY = 86_400_000;

/**
 * Consistency factor relating the median absolute deviation to the standard
 * deviation for a normal distribution (1 / 0.6745).
 */
const MAD_TO_SIGMA = 1.4826;

// ─── Collection ──────────────────────────────────────────────────────────────

/** In-memory observation store keyed by network passphrase. */
const observationsByNetwork = new Map<string, NormalizedFeeObservation[]>();

function toEpochMs(timestamp: number | string): number | null {
  if (typeof timestamp === "number") {
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Record a fee observation for later forecasting.
 *
 * Malformed observations are ignored. The store is bounded to
 * {@link FEE_OBSERVATION_MAX_ENTRIES} entries per network, oldest first.
 *
 * This is a synchronous in-memory write and never performs I/O, so recording
 * observations does not block normal transaction operations.
 */
export function recordFeeObservation(
  observation: FeeObservation,
  networkPassphrase = "default",
): void {
  const timestamp = toEpochMs(observation.timestamp);
  if (timestamp === null) return;
  if (!Number.isFinite(observation.feeStroops) || observation.feeStroops < 0) {
    return;
  }

  const history = observationsByNetwork.get(networkPassphrase) ?? [];
  history.push({ timestamp, feeStroops: observation.feeStroops });
  // Keep ascending by timestamp so callers can rely on ordering.
  history.sort((a, b) => a.timestamp - b.timestamp);
  while (history.length > FEE_OBSERVATION_MAX_ENTRIES) {
    history.shift();
  }
  observationsByNetwork.set(networkPassphrase, history);
}

/** Get a copy of the collected fee observations for a network. */
export function getFeeObservations(
  networkPassphrase = "default",
): NormalizedFeeObservation[] {
  return [...(observationsByNetwork.get(networkPassphrase) ?? [])];
}

/** Clear collected observations for one network, or for all networks. */
export function clearFeeObservations(networkPassphrase?: string): void {
  if (networkPassphrase) {
    observationsByNetwork.delete(networkPassphrase);
  } else {
    observationsByNetwork.clear();
  }
}

// ─── Normalisation ───────────────────────────────────────────────────────────

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  const lower = sorted[mid - 1] ?? 0;
  const upper = sorted[mid] ?? 0;
  return (lower + upper) / 2;
}

/**
 * Validate, sort, and de-noise raw fee observations.
 *
 * Observations with an unparseable timestamp or a non-finite / negative fee are
 * discarded. Remaining observations are sorted ascending by timestamp, then
 * screened for outliers using a modified z-score (median absolute deviation),
 * which is robust to the very spikes it is meant to catch.
 */
export function normalizeFeeHistory(
  observations: FeeObservation[],
  options: NormalizeFeeHistoryOptions = {},
): NormalizedFeeHistory {
  const { outlierThreshold = DEFAULT_OUTLIER_THRESHOLD } = options;
  const discarded: DiscardedObservation[] = [];
  const valid: NormalizedFeeObservation[] = [];

  for (const observation of observations) {
    const timestamp = toEpochMs(observation.timestamp);
    if (timestamp === null) {
      discarded.push({ observation, reason: "invalid_timestamp" });
      continue;
    }
    if (!Number.isFinite(observation.feeStroops) || observation.feeStroops < 0) {
      discarded.push({ observation, reason: "invalid_fee" });
      continue;
    }
    valid.push({ timestamp, feeStroops: observation.feeStroops });
  }

  valid.sort((a, b) => a.timestamp - b.timestamp);

  if (outlierThreshold === null || valid.length < 3) {
    return { observations: valid, discarded };
  }

  const fees = valid.map((o) => o.feeStroops);
  const medianFee = median([...fees].sort((a, b) => a - b));
  const deviations = fees.map((f) => Math.abs(f - medianFee));
  const mad = median([...deviations].sort((a, b) => a - b));

  // With a zero MAD the distribution is degenerate (most values identical);
  // scoring against it would flag every non-identical value as an outlier.
  if (mad === 0) {
    return { observations: valid, discarded };
  }

  const kept: NormalizedFeeObservation[] = [];
  for (const observation of valid) {
    const score =
      Math.abs(observation.feeStroops - medianFee) / (MAD_TO_SIGMA * mad);
    if (score > outlierThreshold) {
      discarded.push({
        observation: {
          timestamp: observation.timestamp,
          feeStroops: observation.feeStroops,
        },
        reason: "outlier",
      });
      continue;
    }
    kept.push(observation);
  }

  return { observations: kept, discarded };
}

// ─── Default model ───────────────────────────────────────────────────────────

/**
 * Approximate the inverse normal CDF (probit) for a two-sided confidence level.
 *
 * Uses the Beasley-Springer-Moro style rational approximation, which is
 * accurate to roughly 4 decimal places across the range we care about — far
 * more precision than fee forecasting warrants, with no dependency cost.
 */
/** Evaluate a polynomial with Horner's method, highest-order coefficient first. */
function horner(coefficients: number[], x: number): number {
  let acc = 0;
  for (const coefficient of coefficients) {
    acc = acc * x + coefficient;
  }
  return acc;
}

const PROBIT_A = [
  -39.696830286653757, 220.9460984245205, -275.92851044696869,
  138.357751867269, -30.664798066147159, 2.5066282774592392,
];
const PROBIT_B = [
  -54.476098798224058, 161.58583685804089, -155.69897985988661,
  66.80131188771972, -13.280681552885721, 1,
];
const PROBIT_C = [
  -0.0077848940024302926, -0.32239645804113648, -2.4007582771618381,
  -2.5497325393437338, 4.3746641414649678, 2.9381639826987831,
];
const PROBIT_D = [
  0.0077846957090414622, 0.32246712907003983, 2.445134137142996,
  3.7544086619074162, 1,
];

const PROBIT_P_LOW = 0.02425;
const PROBIT_P_HIGH = 1 - PROBIT_P_LOW;

function zScoreForConfidence(confidenceLevel: number): number {
  const clamped = Math.min(Math.max(confidenceLevel, 0.5), 0.999999);
  const p = 1 - (1 - clamped) / 2;

  if (p < PROBIT_P_LOW) {
    const q = Math.sqrt(-2 * Math.log(p));
    return horner(PROBIT_C, q) / horner(PROBIT_D, q);
  }

  if (p > PROBIT_P_HIGH) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -horner(PROBIT_C, q) / horner(PROBIT_D, q);
  }

  const q = p - 0.5;
  const r = q * q;
  return (horner(PROBIT_A, r) * q) / horner(PROBIT_B, r);
}

/**
 * Ordinary-least-squares trend model over time.
 *
 * Fits `fee = intercept + slope * days` and widens the confidence range with
 * the residual standard error, so a volatile history yields a wider range at
 * the same confidence level.
 */
export const linearFeeForecastModel: FeeForecastModel = {
  name: "linear-regression",
  minObservations: 3,

  forecast(observations, daysAhead, confidenceLevel) {
    const origin = observations[0]?.timestamp ?? 0;
    const xs = observations.map((o) => (o.timestamp - origin) / MS_PER_DAY);
    const ys = observations.map((o) => o.feeStroops);
    const n = observations.length;

    const meanX = xs.reduce((sum, x) => sum + x, 0) / n;
    const meanY = ys.reduce((sum, y) => sum + y, 0) / n;

    let covariance = 0;
    let varianceX = 0;
    for (let i = 0; i < n; i += 1) {
      const dx = (xs[i] ?? 0) - meanX;
      covariance += dx * ((ys[i] ?? 0) - meanY);
      varianceX += dx * dx;
    }

    // All observations share one timestamp — no trend is identifiable, so fall
    // back to a flat projection at the mean.
    const slope = varianceX === 0 ? 0 : covariance / varianceX;
    const intercept = meanY - slope * meanX;

    let sumSquaredResiduals = 0;
    for (let i = 0; i < n; i += 1) {
      const residual = (ys[i] ?? 0) - (intercept + slope * (xs[i] ?? 0));
      sumSquaredResiduals += residual * residual;
    }
    // Two degrees of freedom are consumed by the slope and intercept.
    const residualStdError =
      n > 2 ? Math.sqrt(sumSquaredResiduals / (n - 2)) : 0;

    const lastX = xs[n - 1] ?? 0;
    const targetX = lastX + daysAhead;
    const predicted = intercept + slope * targetX;

    // Prediction interval: uncertainty grows with distance from the mean of
    // the observed x values, so a forecast far past the data widens correctly.
    const leverage =
      varianceX === 0
        ? 1 / n
        : 1 / n + ((targetX - meanX) * (targetX - meanX)) / varianceX;
    const margin =
      zScoreForConfidence(confidenceLevel) *
      residualStdError *
      Math.sqrt(1 + leverage);

    const variance =
      ys.reduce((sum, y) => sum + (y - meanY) * (y - meanY), 0) / n;

    return {
      predictedFeeStroops: Math.max(0, predicted),
      lowerBoundStroops: Math.max(0, predicted - margin),
      upperBoundStroops: Math.max(0, predicted + margin),
      trendPerDayStroops: slope,
      volatilityStroops: Math.sqrt(variance),
    };
  },
};

// ─── Core API ────────────────────────────────────────────────────────────────

function describeWindow(
  observations: NormalizedFeeObservation[],
  discardedCount: number,
): ForecastDataWindow {
  const first = observations[0];
  const last = observations[observations.length - 1];
  const startTimestamp = first?.timestamp ?? null;
  const endTimestamp = last?.timestamp ?? null;
  const spanDays =
    startTimestamp !== null && endTimestamp !== null
      ? (endTimestamp - startTimestamp) / MS_PER_DAY
      : 0;

  return {
    observationCount: observations.length,
    startTimestamp,
    endTimestamp,
    spanDays,
    discardedCount,
  };
}

/**
 * Forecast the transaction fee `daysAhead` days into the future.
 *
 * Observations are taken from `options.observations` when supplied, otherwise
 * from the observations collected via {@link recordFeeObservation}. The result
 * always reports the data window used, and reports insufficient history
 * explicitly instead of returning a misleading number.
 *
 * @param daysAhead - Days into the future to project. Must be finite and >= 0.
 * @param options   - Data source, confidence level, and model overrides.
 */
export function forecastFees(
  daysAhead: number,
  options: ForecastFeesOptions = {},
): FeeForecastResult {
  const {
    networkPassphrase = "default",
    confidenceLevel = DEFAULT_FORECAST_CONFIDENCE_LEVEL,
    model = linearFeeForecastModel,
    normalize = {},
  } = options;

  const raw: FeeObservation[] =
    options.observations ?? getFeeObservations(networkPassphrase);
  const { observations, discarded } = normalizeFeeHistory(raw, normalize);
  const dataWindow = describeWindow(observations, discarded.length);

  if (!Number.isFinite(daysAhead) || daysAhead < 0) {
    return {
      available: false,
      reason: "invalid_days_ahead",
      message: `daysAhead must be a finite number >= 0, received ${daysAhead}.`,
      dataWindow,
    };
  }

  if (observations.length < model.minObservations) {
    return {
      available: false,
      reason: "insufficient_data",
      message:
        `Model "${model.name}" requires at least ${model.minObservations} ` +
        `observations, received ${observations.length}.`,
      dataWindow,
    };
  }

  const prediction = model.forecast(observations, daysAhead, confidenceLevel);

  return {
    available: true,
    forecast: {
      daysAhead,
      predictedFeeStroops: prediction.predictedFeeStroops,
      lowerBoundStroops: prediction.lowerBoundStroops,
      upperBoundStroops: prediction.upperBoundStroops,
      confidenceLevel,
      trendPerDayStroops: prediction.trendPerDayStroops,
      volatilityStroops: prediction.volatilityStroops,
      dataWindow,
      model: model.name,
    },
  };
}

/**
 * Score a model against a historical dataset using walk-forward evaluation.
 *
 * For each point past `warmupSize`, the model forecasts one step ahead from
 * only the preceding observations, and the prediction is compared against the
 * fee that actually occurred. Points the model cannot forecast are skipped.
 *
 * @param history    - The full historical dataset, in any order.
 * @param options    - Warmup size, confidence level, and model overrides.
 */
export function evaluateForecastAccuracy(
  history: FeeObservation[],
  options: {
    /** Observations used to seed the first forecast. Default: model minimum. */
    warmupSize?: number;
    confidenceLevel?: number;
    model?: FeeForecastModel;
    normalize?: NormalizeFeeHistoryOptions;
  } = {},
): ForecastAccuracyReport {
  const {
    confidenceLevel = DEFAULT_FORECAST_CONFIDENCE_LEVEL,
    model = linearFeeForecastModel,
    normalize = {},
  } = options;
  const warmupSize = options.warmupSize ?? model.minObservations;

  const { observations } = normalizeFeeHistory(history, normalize);
  const samples: ForecastAccuracySample[] = [];

  for (let i = warmupSize; i < observations.length; i += 1) {
    const actual = observations[i];
    const previous = observations[i - 1];
    if (!actual || !previous) continue;

    const window = observations.slice(0, i);
    const daysAhead = (actual.timestamp - previous.timestamp) / MS_PER_DAY;
    const result = forecastFees(Math.max(0, daysAhead), {
      observations: window,
      confidenceLevel,
      model,
      // The window is already normalised; re-screening it would drop points
      // the model legitimately trained on.
      normalize: { outlierThreshold: null },
    });
    if (!result.available) continue;

    const { predictedFeeStroops, lowerBoundStroops, upperBoundStroops } =
      result.forecast;
    samples.push({
      predictedFeeStroops,
      actualFeeStroops: actual.feeStroops,
      withinConfidenceRange:
        actual.feeStroops >= lowerBoundStroops &&
        actual.feeStroops <= upperBoundStroops,
    });
  }

  if (samples.length === 0) {
    return {
      sampleCount: 0,
      meanAbsoluteErrorStroops: 0,
      meanAbsolutePercentageError: 0,
      rootMeanSquaredErrorStroops: 0,
      confidenceRangeCoverage: 0,
      samples,
    };
  }

  let absoluteError = 0;
  let percentageError = 0;
  let squaredError = 0;
  let withinRange = 0;
  let percentageSamples = 0;

  for (const sample of samples) {
    const error = sample.predictedFeeStroops - sample.actualFeeStroops;
    absoluteError += Math.abs(error);
    squaredError += error * error;
    // A zero actual makes percentage error undefined — exclude those points
    // rather than letting them poison the mean with Infinity.
    if (sample.actualFeeStroops !== 0) {
      percentageError += Math.abs(error) / sample.actualFeeStroops;
      percentageSamples += 1;
    }
    if (sample.withinConfidenceRange) withinRange += 1;
  }

  return {
    sampleCount: samples.length,
    meanAbsoluteErrorStroops: absoluteError / samples.length,
    meanAbsolutePercentageError:
      percentageSamples === 0 ? 0 : percentageError / percentageSamples,
    rootMeanSquaredErrorStroops: Math.sqrt(squaredError / samples.length),
    confidenceRangeCoverage: withinRange / samples.length,
    samples,
  };
}
