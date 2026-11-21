/**
 * Runtime validators for the SDK's most commonly consumed public shapes.
 *
 * The SDK's types (AccountInfo, AssetBalance, ResolvedNetworkConfig, ...)
 * are compile-time-only TypeScript interfaces. Code that receives untrusted
 * data at runtime — a Horizon response, a value deserialized from storage,
 * a value from an API boundary outside the SDK's control — has no way to
 * confirm that data actually matches the expected shape before using it.
 *
 * These validators close that gap. Deliberately hand-written rather than
 * built on a schema library (e.g. zod): the SDK ships with zero runtime
 * dependencies beyond @scure/bip39 and smol-toml, and pulling in a schema
 * library just for a handful of shape checks would be a disproportionate
 * footprint increase for a tree-shaken, bundle-size-sensitive SDK.
 *
 * Every validator:
 * - returns a SorokitResult<T> and never throws (matches shared/validation.ts),
 * - narrows `unknown` input to the target type on success,
 * - reports every problem found, not just the first (so a caller logging the
 *   error sees everything wrong with the payload in one pass).
 */

import { ok, err, SorokitErrorCode } from "./shared/response";
import type { SorokitResult } from "./shared/response";
import type { AccountInfo, AssetBalance } from "./account/types";
import type { ResolvedNetworkConfig } from "./shared/types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ASSET_BALANCE_TYPES = new Set([
  "native",
  "credit_alphanum4",
  "credit_alphanum12",
  "liquidity_pool_shares",
]);

const NETWORK_NAMES = new Set(["mainnet", "testnet", "futurenet"]);

/**
 * Validate that a value matches the {@link AssetBalance} shape.
 *
 * @example
 * const result = validateAssetBalance(JSON.parse(rawResponse));
 * if (result.status === "error") {
 *   logger.warn("Unexpected balance shape", { issues: result.error.message });
 *   return;
 * }
 * const balance: AssetBalance = result.data;
 */
export function validateAssetBalance(value: unknown): SorokitResult<AssetBalance> {
  if (!isRecord(value)) {
    return err(
      SorokitErrorCode.VALIDATION,
      "AssetBalance — value is not an object.",
    );
  }

  const issues: string[] = [];

  if (typeof value.assetType !== "string" || !ASSET_BALANCE_TYPES.has(value.assetType)) {
    issues.push(
      `assetType must be one of ${[...ASSET_BALANCE_TYPES].join(", ")}, got ${JSON.stringify(value.assetType)}.`,
    );
  }
  if (typeof value.assetCode !== "string") {
    issues.push("assetCode must be a string.");
  }
  if (value.assetIssuer !== null && typeof value.assetIssuer !== "string") {
    issues.push("assetIssuer must be a string or null.");
  }
  if (typeof value.balance !== "string") {
    issues.push("balance must be a string.");
  }
  if (typeof value.balanceFloat !== "number" || Number.isNaN(value.balanceFloat)) {
    issues.push("balanceFloat must be a finite number.");
  }
  if (value.liquidityPoolId !== undefined && typeof value.liquidityPoolId !== "string") {
    issues.push("liquidityPoolId must be a string when present.");
  }

  if (issues.length > 0) {
    return err(SorokitErrorCode.VALIDATION, `AssetBalance — ${issues.join(" ")}`);
  }

  return ok(value as unknown as AssetBalance);
}

/**
 * Validate that a value matches the {@link AccountInfo} shape, including
 * recursively validating every entry in `balances`.
 */
export function validateAccountInfo(value: unknown): SorokitResult<AccountInfo> {
  if (!isRecord(value)) {
    return err(
      SorokitErrorCode.VALIDATION,
      "AccountInfo — value is not an object.",
    );
  }

  const issues: string[] = [];

  if (typeof value.publicKey !== "string" || value.publicKey.length === 0) {
    issues.push("publicKey must be a non-empty string.");
  }
  if (typeof value.displayAddress !== "string") {
    issues.push("displayAddress must be a string.");
  }
  if (typeof value.sequence !== "string") {
    issues.push("sequence must be a string.");
  }
  if (typeof value.subentryCount !== "number" || Number.isNaN(value.subentryCount)) {
    issues.push("subentryCount must be a finite number.");
  }
  if (!Array.isArray(value.balances)) {
    issues.push("balances must be an array.");
  } else {
    value.balances.forEach((balance, index) => {
      const result = validateAssetBalance(balance);
      if (result.status === "error") {
        issues.push(`balances[${index}]: ${result.error.message}`);
      }
    });
  }

  if (issues.length > 0) {
    return err(SorokitErrorCode.VALIDATION, `AccountInfo — ${issues.join(" ")}`);
  }

  return ok(value as unknown as AccountInfo);
}

/**
 * Validate that a value matches the {@link ResolvedNetworkConfig} shape.
 * URL fields are checked for well-formedness only (same rule as
 * {@link resolveNetwork}'s override validation) — not reachability.
 */
export function validateResolvedNetworkConfig(
  value: unknown,
): SorokitResult<ResolvedNetworkConfig> {
  if (!isRecord(value)) {
    return err(
      SorokitErrorCode.VALIDATION,
      "ResolvedNetworkConfig — value is not an object.",
    );
  }

  const issues: string[] = [];

  if (typeof value.network !== "string" || !NETWORK_NAMES.has(value.network)) {
    issues.push(
      `network must be one of ${[...NETWORK_NAMES].join(", ")}, got ${JSON.stringify(value.network)}.`,
    );
  }
  for (const field of ["horizonUrl", "rpcUrl"] as const) {
    const fieldValue = value[field];
    if (typeof fieldValue !== "string") {
      issues.push(`${field} must be a string.`);
      continue;
    }
    try {
      new URL(fieldValue);
    } catch {
      issues.push(`${field} ("${fieldValue}") is not a well-formed URL.`);
    }
  }
  if (typeof value.networkPassphrase !== "string" || value.networkPassphrase.length === 0) {
    issues.push("networkPassphrase must be a non-empty string.");
  }
  if (
    value.baseFeeMultiplier !== undefined &&
    (typeof value.baseFeeMultiplier !== "number" || Number.isNaN(value.baseFeeMultiplier))
  ) {
    issues.push("baseFeeMultiplier must be a finite number when present.");
  }

  if (issues.length > 0) {
    return err(
      SorokitErrorCode.VALIDATION,
      `ResolvedNetworkConfig — ${issues.join(" ")}`,
    );
  }

  return ok(value as unknown as ResolvedNetworkConfig);
}
