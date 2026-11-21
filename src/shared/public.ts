/**
 * Stable shared helpers exported by the SDK's `sorokit-core/shared` entrypoint.
 *
 * Internal shared implementation modules intentionally remain reachable only by
 * source-relative imports and are not part of the package export map.
 */
export {
  formatAmount,
  DEFAULT_ASSET_DECIMALS,
} from "./amountFormatter";
export type { FormatAmountOptions } from "./amountFormatter";

export {
  validateStellarAddress,
  validatePublicKey,
  validateAssetCode,
  validateAmount,
} from "./validation";

export {
  validateStroop,
  xlmToStroops,
  stroopsToXlm,
  STROOPS_PER_XLM,
  MAX_STROOPS,
  MAX_AMOUNT,
} from "./amountValidation";

export {
  checkMainnetSafety,
  extractTransactionTotalXlm,
  isMainnetNetwork,
  DEFAULT_MAINNET_SAFETY_THRESHOLD_XLM,
  MAINNET_NETWORK_PASSPHRASE,
} from "./mainnetSafety";
