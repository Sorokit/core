import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

/**
 * Default threshold for price feed staleness: 5 minutes (300,000 ms).
 */
export const DEFAULT_PRICE_FEED_STALENESS_THRESHOLD_MS = 5 * 60 * 1000;

export interface PriceFeedQuote {
  /** Asset identifier or code (e.g. "XLM", "USDC"). */
  asset: string;
  /** Counter currency (e.g. "USD"). Defaults to "USD". */
  currency?: string;
  /** Quoted price. Must be a positive finite number. */
  price: number;
  /**
   * Timestamp of the price update.
   * Can be epoch ms, epoch seconds (if < 1e11), Date, or ISO string.
   */
  timestamp?: number | string | Date;
  /** Alternative alias for timestamp. */
  updatedAt?: number | string | Date;
  /** Estimated price impact percentage (0 to 100). */
  priceImpactPercent?: number;
  /** Optional feed status or health. */
  status?: "fresh" | "stale" | string;
  /** Optional confidence interval or uncertainty estimate. */
  confidence?: number;
}

export type StalePriceFeedAction = "reject" | "warn";

export interface PriceOracleOptions {
  /**
   * Maximum acceptable age of price feed data in milliseconds.
   * Defaults to 5 minutes (300,000 ms).
   */
  stalenessThresholdMs?: number;
  /**
   * Action to take when a price feed is stale.
   * - "reject": returns an error result.
   * - "warn": returns an ok result but logs or invokes warning callback.
   * Defaults to "reject".
   */
  onStale?: StalePriceFeedAction;
  /** Optional custom warning logger or callback when stale data is accepted with "warn". */
  onStaleWarning?: (warning: string, quote: PriceFeedQuote) => void;
  /** Custom current time function for deterministic testing. */
  getCurrentTimeMs?: () => number;
}

export interface PriceFeedValidationResult {
  isStale: boolean;
  ageMs: number;
  quoteTimestampMs: number | null;
  thresholdMs: number;
}

/**
 * Normalize timestamp into milliseconds epoch time.
 */
export function normalizeTimestampToMs(
  timestamp?: number | string | Date,
): number | null {
  if (timestamp === undefined || timestamp === null) return null;
  if (timestamp instanceof Date) {
    const ms = timestamp.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof timestamp === "number") {
    if (!Number.isFinite(timestamp) || timestamp < 0) return null;
    // If timestamp is in seconds (less than 100 billion, i.e., before Nov 2286 in seconds)
    if (timestamp < 1e11) {
      return timestamp * 1000;
    }
    return timestamp;
  }
  if (typeof timestamp === "string") {
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Check if a price feed quote is stale.
 *
 * @param quote - The price quote to evaluate.
 * @param thresholdMs - Staleness threshold in ms (defaults to 5 minutes).
 * @param currentTimeMs - Current time in ms (defaults to Date.now()).
 */
export function checkPriceFeedStaleness(
  quote: PriceFeedQuote,
  thresholdMs = DEFAULT_PRICE_FEED_STALENESS_THRESHOLD_MS,
  currentTimeMs: number = Date.now(),
): PriceFeedValidationResult {
  const rawTs = quote.timestamp ?? quote.updatedAt;
  const quoteTimestampMs = normalizeTimestampToMs(rawTs);

  if (quoteTimestampMs === null) {
    // Missing timestamp is considered indeterminate / stale by default
    return {
      isStale: true,
      ageMs: Infinity,
      quoteTimestampMs: null,
      thresholdMs,
    };
  }

  const ageMs = Math.max(0, currentTimeMs - quoteTimestampMs);
  const isStale = ageMs > thresholdMs;

  return {
    isStale,
    ageMs,
    quoteTimestampMs,
    thresholdMs,
  };
}

/**
 * Validates a price feed quote, ensuring positive finite price and enforcing staleness rules.
 */
export function validatePriceFeedQuote(
  quote: PriceFeedQuote,
  options: PriceOracleOptions = {},
): SorokitResult<PriceFeedQuote> {
  if (!quote || typeof quote !== "object") {
    return err(
      SorokitErrorCode.VALIDATION,
      "Price feed quote is missing or invalid.",
    );
  }

  if (
    typeof quote.price !== "number" ||
    !Number.isFinite(quote.price) ||
    quote.price <= 0
  ) {
    return err(
      SorokitErrorCode.VALIDATION,
      `Price feed returned invalid price: ${quote.price}. Price must be a positive finite number.`,
    );
  }

  const thresholdMs =
    options.stalenessThresholdMs ?? DEFAULT_PRICE_FEED_STALENESS_THRESHOLD_MS;
  const onStale = options.onStale ?? "reject";
  const now = options.getCurrentTimeMs ? options.getCurrentTimeMs() : Date.now();

  const staleness = checkPriceFeedStaleness(quote, thresholdMs, now);

  if (staleness.isStale) {
    const ageSec = (staleness.ageMs / 1000).toFixed(1);
    const thresholdSec = (thresholdMs / 1000).toFixed(0);
    const warningMessage =
      `Price feed for ${quote.asset} is stale (age: ${ageSec}s exceeds threshold of ${thresholdSec}s).`;

    if (onStale === "reject") {
      return err(
        SorokitErrorCode.SERVICE_UNAVAILABLE,
        warningMessage,
        undefined,
        undefined,
        {
          context: {
            operation: "validatePriceFeedQuote",
            parameters: {
              asset: quote.asset,
              price: quote.price,
              ageMs: staleness.ageMs,
              thresholdMs,
            },
          },
          recovery: {
            retryable: true,
            action: "Refresh the price oracle feed or select an active oracle endpoint before proceeding.",
          },
        },
      );
    }

    // On warn
    if (options.onStaleWarning) {
      options.onStaleWarning(warningMessage, quote);
    } else {
      console.warn(`[sorokit] ${warningMessage}`);
    }

    return ok({
      ...quote,
      status: "stale",
    });
  }

  return ok({
    ...quote,
    status: quote.status ?? "fresh",
  });
}

/**
 * Underlying interface for external price feed providers.
 */
export interface PriceFeedProvider {
  getPrice(asset: string, currency?: string): Promise<PriceFeedQuote>;
}

/**
 * Price Oracle client with built-in staleness detection and conversion helpers.
 */
export class PriceOracle {
  private readonly provider: PriceFeedProvider;
  private readonly options: PriceOracleOptions;

  constructor(provider: PriceFeedProvider, options: PriceOracleOptions = {}) {
    this.provider = provider;
    this.options = {
      stalenessThresholdMs: DEFAULT_PRICE_FEED_STALENESS_THRESHOLD_MS,
      onStale: "reject",
      ...options,
    };
  }

  /**
   * Retrieve price quote for an asset, with automatic staleness check.
   */
  async getPrice(
    asset: string,
    currency = "USD",
  ): Promise<SorokitResult<PriceFeedQuote>> {
    try {
      const quote = await this.provider.getPrice(asset, currency);
      return validatePriceFeedQuote(quote, this.options);
    } catch (cause) {
      return err(
        SorokitErrorCode.SERVICE_UNAVAILABLE,
        `Failed to fetch price quote from oracle for ${asset}: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      );
    }
  }

  /**
   * Estimate fee in counter-currency or native units using oracle prices.
   *
   * @param feeStroops - Fee in stroops (1 XLM = 10,000,000 stroops).
   * @param targetCurrency - Target currency (e.g. "USD").
   */
  async estimateFeeInCurrency(
    feeStroops: bigint | number | string,
    targetCurrency = "USD",
  ): Promise<SorokitResult<{ feeInCurrency: number; xlmPrice: number }>> {
    const xlmQuoteResult = await this.getPrice("XLM", targetCurrency);
    if (xlmQuoteResult.status === "error") {
      return xlmQuoteResult;
    }

    const stroops = BigInt(feeStroops);
    const xlmAmount = Number(stroops) / 10_000_000;
    const feeInCurrency = xlmAmount * xlmQuoteResult.data.price;

    return ok({
      feeInCurrency,
      xlmPrice: xlmQuoteResult.data.price,
    });
  }

  /**
   * Convert an amount between two assets using verified fresh oracle prices.
   */
  async convertRate(
    amount: number,
    fromAsset: string,
    toAsset: string,
    currency = "USD",
  ): Promise<SorokitResult<{ convertedAmount: number; rate: number }>> {
    if (amount <= 0 || !Number.isFinite(amount)) {
      return err(
        SorokitErrorCode.VALIDATION,
        "Amount must be a positive finite number.",
      );
    }

    const [fromRes, toRes] = await Promise.all([
      this.getPrice(fromAsset, currency),
      this.getPrice(toAsset, currency),
    ]);

    if (fromRes.status === "error") return fromRes;
    if (toRes.status === "error") return toRes;

    const rate = fromRes.data.price / toRes.data.price;
    const convertedAmount = amount * rate;

    return ok({
      convertedAmount,
      rate,
    });
  }
}

/**
 * Create a new PriceOracle instance.
 */
export function createPriceOracle(
  provider: PriceFeedProvider,
  options?: PriceOracleOptions,
): PriceOracle {
  return new PriceOracle(provider, options);
}
