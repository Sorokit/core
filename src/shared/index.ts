export * from "./cache";
export * from "./cacheInvalidation";
export * from "./config";
export * from "./constants";
export * from "./errors";
export * from "./logger";
export * from "./devtoolsBridge";
export * from "./metrics";
export * from "./response";
export * from "./utils";
export * from "./tracing";
// Note: shared/types.ts re-exports from the above — do not re-export it here
// to avoid circular barrel exports
export * from "./validateIssuer";
// validateToken exports validateAssetCode and validateAssetIssuer with a void
// return type (non-empty check only). The centralised validators in validation.ts
// supersede those with full format + checksum validation and a SorokitResult<string>
// return. Export the remaining validateToken utilities here to preserve backward
// compatibility; the two overlapping names are supplied by validation.ts below.
export {
  validateTokenAsset,
  isSameAsset,
  normalizePairId,
} from "./validateToken";
export type { TokenAsset } from "./validateToken";
export * from "./i18n";

// ─── SDK health checks & diagnostics (#527) ───────────────────────────────────
export * from "./diagnostics";

// ─── Centralized input validation ─────────────────────────────────────────────
// validateStellarAddress, validatePublicKey, validateAssetCode, validateAssetIssuer,
// validateAmount, and their associated constants.
export * from "./validation";
export {
  validateStroop,
  xlmToStroops,
  stroopsToXlm,
  STROOPS_PER_XLM,
  MAX_STROOPS,
  MAX_AMOUNT,
} from "./amountValidation";
export { formatAmount, DEFAULT_ASSET_DECIMALS } from "./amountFormatter";
export type { FormatAmountOptions } from "./amountFormatter";
export {
  getAssetInfo,
  registerAsset,
  unregisterAsset,
  listKnownAssets,
  canonicalAssetId,
} from "./assetRegistry";
export type { AssetInfo, AssetMetadata } from "./assetRegistry";
export * from "./mainnetSafety";
export * from "./keyManagement";

export {
  StructuredLogger,
} from "./structuredLogging.js";
export type {
  LogConfig,
  LogLevel as StructuredLogLevel,
} from "./structuredLogging.js";

// ─── OpenTelemetry (#600) & SmartCache (#604) ────────────────────────────────
export * from "./openTelemetry";
export * from "./smartCache";

