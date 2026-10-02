import { Account, BASE_FEE, Horizon, TransactionBuilder } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { ResolvedNetworkConfig } from "../shared/types";
import { toMessage } from "../shared";
import { buildDataEntryOperation } from "../account/dataEntries";

export interface DataEntryTransactionOptions { sequenceNumber?: string; fee?: string; timeout?: number; }
async function build(horizonUrl: string, networkConfig: ResolvedNetworkConfig, sourcePublicKey: string, key: string, value: string | null, options: DataEntryTransactionOptions = {}): Promise<SorokitResult<string>> {
  try {
    const account = options.sequenceNumber !== undefined ? new Account(sourcePublicKey, options.sequenceNumber) : await new Horizon.Server(horizonUrl).loadAccount(sourcePublicKey);
    const operation = buildDataEntryOperation(key, value); if (operation.status === "error") return operation;
    const tx = new TransactionBuilder(account, { fee: options.fee ?? BASE_FEE, networkPassphrase: networkConfig.networkPassphrase }).addOperation(operation.data).setTimeout(options.timeout ?? 30).build();
    return ok(tx.toXDR());
  } catch (cause) { return err(SorokitErrorCode.TX_BUILD_FAILED, `Failed to build data-entry transaction: ${toMessage(cause)}`, cause); }
}
export function buildSetDataEntryTransaction(horizonUrl: string, networkConfig: ResolvedNetworkConfig, sourcePublicKey: string, key: string, value: string, options?: DataEntryTransactionOptions): Promise<SorokitResult<string>> { return build(horizonUrl, networkConfig, sourcePublicKey, key, value, options); }
export function buildDeleteDataEntryTransaction(horizonUrl: string, networkConfig: ResolvedNetworkConfig, sourcePublicKey: string, key: string, options?: DataEntryTransactionOptions): Promise<SorokitResult<string>> { return build(horizonUrl, networkConfig, sourcePublicKey, key, null, options); }
