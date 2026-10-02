import { Horizon, Operation } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { isNotFoundError, toMessage } from "../shared";

export type AccountDataEntries = Record<string, string>;
const MAX_BYTES = 64;
function bytes(value: string): number { return new TextEncoder().encode(value).byteLength; }
function validateKey(key: string): SorokitResult<string> { if (!key || bytes(key) > MAX_BYTES) return err(SorokitErrorCode.VALIDATION, "Data entry key must be non-empty and at most 64 UTF-8 bytes."); return ok(key); }
function validateValue(value: string | null): SorokitResult<string | null> { if (value !== null && bytes(value) > MAX_BYTES) return err(SorokitErrorCode.VALIDATION, "Data entry value must be at most 64 UTF-8 bytes."); return ok(value); }
export async function getDataEntries(horizonUrl: string, publicKey: string): Promise<SorokitResult<AccountDataEntries>> {
  try { const account = await new Horizon.Server(horizonUrl).loadAccount(publicKey); return ok(Object.fromEntries(Object.entries((account as any).data ?? {}).map(([key, value]) => [key, typeof value === "string" ? value : String(value)]))); }
  catch (cause) { const nf = isNotFoundError(cause); return err(nf ? SorokitErrorCode.ACCOUNT_NOT_FOUND : SorokitErrorCode.ACCOUNT_FETCH_FAILED, nf ? `Account not found: ${publicKey}` : `Failed to fetch data entries for ${publicKey}: ${toMessage(cause)}`, cause); }
}
export function buildDataEntryOperation(key: string, value: string | null): SorokitResult<any> {
  const keyResult = validateKey(key); if (keyResult.status === "error") return keyResult;
  const valueResult = validateValue(value); if (valueResult.status === "error") return valueResult;
  try { return ok(Operation.manageData({ name: key, value })); }
  catch (cause) { return err(SorokitErrorCode.TX_BUILD_FAILED, `Failed to build data entry operation: ${toMessage(cause)}`, cause); }
}
export { validateKey as validateDataEntryKey, validateValue as validateDataEntryValue };
