import { Contract, rpc as SorobanRpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage } from "../shared";
import { createSorobanServer } from "../shared/serverFactory";

export type ContractDurability = "persistent" | "temporary";

/**
 * Read one contract data entry from ledger storage and decode it to a native value.
 * Returns `error(CONTRACT_READ_FAILED)` when the entry does not exist.
 */
export async function getContractData(
  rpcUrl: string,
  contractId: string,
  key: xdr.ScVal,
  durability: ContractDurability = "persistent",
): Promise<SorokitResult<unknown>> {
  try {
    const rpc = createSorobanServer(rpcUrl) as SorobanRpc.Server;
    const d =
      durability === "temporary"
        ? SorobanRpc.Durability.Temporary
        : SorobanRpc.Durability.Persistent;
    const response = await rpc.getContractData(contractId, key, d);
    return ok(scValToNative(response.val.contractData().val()));
  } catch (cause) {
    return err(
      SorokitErrorCode.CONTRACT_READ_FAILED,
      `Failed to read contract data: ${toMessage(cause)}`,
      cause,
    );
  }
}

/**
 * Read the contract's instance storage map, decoded to native key/value pairs.
 * Persistent and temporary entries cannot be enumerated over RPC; use
 * `getContractData` with a known key for those.
 */
export async function getContractStorage(
  rpcUrl: string,
  contractId: string,
): Promise<SorokitResult<Array<{ key: unknown; value: unknown }>>> {
  try {
    const rpc = createSorobanServer(rpcUrl) as SorobanRpc.Server;
    const footprint = new Contract(contractId).getFootprint();
    const response = await rpc.getLedgerEntries(footprint);
    const entry = response.entries[0];
    if (!entry) {
      return err(SorokitErrorCode.CONTRACT_READ_FAILED, `Contract ${contractId} not found`);
    }
    const instance = entry.val.contractData().val().instance();
    const map = instance.storage() ?? [];
    return ok(
      map.map((e: xdr.ScMapEntry) => ({ key: scValToNative(e.key()), value: scValToNative(e.val()) })),
    );
  } catch (cause) {
    return err(
      SorokitErrorCode.CONTRACT_READ_FAILED,
      `Failed to read contract storage: ${toMessage(cause)}`,
      cause,
    );
  }
}
