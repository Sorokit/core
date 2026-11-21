import { Horizon, Operation } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { isNotFoundError, toMessage } from "../shared";

export type AccountDataEntries = Record<string, string>;
export type DataEntryValue = string | Uint8Array | Buffer;

export const MAX_DATA_ENTRY_KEY_BYTES = 64;
export const MAX_DATA_ENTRY_VALUE_BYTES = 64;

export function getDataByteLength(value: string | Uint8Array | Buffer): number {
  if (typeof value === "string") {
    return new TextEncoder().encode(value).byteLength;
  }
  if (value instanceof Uint8Array || (typeof Buffer !== "undefined" && Buffer.isBuffer(value))) {
    return value.byteLength;
  }
  return 0;
}

function validateKey(key: string): SorokitResult<string> {
  if (!key || typeof key !== "string") {
    return err(SorokitErrorCode.VALIDATION, "Data entry key must be non-empty.");
  }
  const actualBytes = getDataByteLength(key);
  if (actualBytes > MAX_DATA_ENTRY_KEY_BYTES) {
    return err(
      SorokitErrorCode.VALIDATION,
      `Data entry key exceeds maximum limit of ${MAX_DATA_ENTRY_KEY_BYTES} bytes (actual: ${actualBytes} bytes).`,
    );
  }
  return ok(key);
}

function validateValue(value: DataEntryValue | null | undefined): SorokitResult<DataEntryValue | null> {
  if (value === null || value === undefined) {
    return ok(null);
  }
  const actualBytes = getDataByteLength(value);
  if (actualBytes > MAX_DATA_ENTRY_VALUE_BYTES) {
    return err(
      SorokitErrorCode.VALIDATION,
      `Data entry value exceeds maximum limit of ${MAX_DATA_ENTRY_VALUE_BYTES} bytes (actual: ${actualBytes} bytes).`,
    );
  }
  return ok(value);
}

export async function getDataEntries(horizonUrl: string, publicKey: string): Promise<SorokitResult<AccountDataEntries>> {
  try {
    const account = await new Horizon.Server(horizonUrl).loadAccount(publicKey);
    return ok(
      Object.fromEntries(
        Object.entries((account as any).data ?? {}).map(([key, value]) => [
          key,
          typeof value === "string" ? value : String(value),
        ]),
      ),
    );
  } catch (cause) {
    const nf = isNotFoundError(cause);
    return err(
      nf ? SorokitErrorCode.ACCOUNT_NOT_FOUND : SorokitErrorCode.ACCOUNT_FETCH_FAILED,
      nf ? `Account not found: ${publicKey}` : `Failed to fetch data entries for ${publicKey}: ${toMessage(cause)}`,
      cause,
    );
  }
}

export function buildDataEntryOperation(key: string, value: DataEntryValue | null | undefined): SorokitResult<any> {
  const keyResult = validateKey(key);
  if (keyResult.status === "error") return keyResult;
  const valueResult = validateValue(value);
  if (valueResult.status === "error") return valueResult;
  try {
    let opValue: string | Buffer | null = null;
    if (value !== null && value !== undefined) {
      if (typeof value === "string") {
        opValue = value;
      } else if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
        opValue = value;
      } else if (value instanceof Uint8Array) {
        opValue = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      }
    }
    return ok(Operation.manageData({ name: key, value: opValue as any }));
  } catch (cause) {
    return err(SorokitErrorCode.TX_BUILD_FAILED, `Failed to build data entry operation: ${toMessage(cause)}`, cause);
  }
}

export {
  validateKey as validateDataEntryKey,
  validateValue as validateDataEntryValue,
};

