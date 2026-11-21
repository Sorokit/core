import { Account, BASE_FEE, Horizon, TransactionBuilder } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { ResolvedNetworkConfig } from "../shared/types";
import { toMessage } from "../shared";
import {
  buildDataEntryOperation,
  validateDataEntryKey,
  validateDataEntryValue,
  getDataByteLength,
  MAX_DATA_ENTRY_KEY_BYTES,
  MAX_DATA_ENTRY_VALUE_BYTES,
} from "../account/dataEntries";
import type { DataEntryValue } from "../account/dataEntries";

export interface DataEntryTransactionOptions {
  sequenceNumber?: string;
  fee?: string;
  timeout?: number;
}

export {
  validateDataEntryKey,
  validateDataEntryValue,
  getDataByteLength,
  MAX_DATA_ENTRY_KEY_BYTES,
  MAX_DATA_ENTRY_VALUE_BYTES,
};
export type { DataEntryValue };

async function build(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  sourcePublicKey: string,
  key: string,
  value: DataEntryValue | null,
  options: DataEntryTransactionOptions = {},
): Promise<SorokitResult<string>> {
  // Validate key and value upfront to reject oversized inputs early
  const keyResult = validateDataEntryKey(key);
  if (keyResult.status === "error") return keyResult;
  const valueResult = validateDataEntryValue(value);
  if (valueResult.status === "error") return valueResult;

  try {
    const account =
      options.sequenceNumber !== undefined
        ? new Account(sourcePublicKey, options.sequenceNumber)
        : await new Horizon.Server(horizonUrl).loadAccount(sourcePublicKey);
    const operation = buildDataEntryOperation(key, value);
    if (operation.status === "error") return operation;
    const tx = new TransactionBuilder(account, {
      fee: options.fee ?? BASE_FEE,
      networkPassphrase: networkConfig.networkPassphrase,
    })
      .addOperation(operation.data)
      .setTimeout(options.timeout ?? 30)
      .build();
    return ok(tx.toXDR());
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Failed to build data-entry transaction: ${toMessage(cause)}`,
      cause,
    );
  }
}

/**
 * Build a transaction to set or update an account data entry.
 * Validates that key and value conform to Stellar XDR encoding limits (max 64 bytes).
 */
export function buildSetDataEntryTransaction(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  sourcePublicKey: string,
  key: string,
  value: DataEntryValue,
  options?: DataEntryTransactionOptions,
): Promise<SorokitResult<string>> {
  return build(horizonUrl, networkConfig, sourcePublicKey, key, value, options);
}

/**
 * Convenience alias for setting account data (#762).
 */
export const setData = buildSetDataEntryTransaction;

/**
 * Build a transaction to delete an account data entry.
 */
export function buildDeleteDataEntryTransaction(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  sourcePublicKey: string,
  key: string,
  options?: DataEntryTransactionOptions,
): Promise<SorokitResult<string>> {
  return build(horizonUrl, networkConfig, sourcePublicKey, key, null, options);
}

/**
 * Convenience alias for deleting account data.
 */
export const deleteData = buildDeleteDataEntryTransaction;

