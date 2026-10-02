import { createHash } from "node:crypto";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { SorokitCache } from "../shared/cache";
import { toMessage } from "../shared";
import { fetchContractWasm, invalidateContractCache } from "./contractMetadata";

const HASH_CACHE_PREFIX = "sorokit:contract-code-hash:";

export interface UpgradeEvent {
  contractId: string;
  previousCodeHash: string | null;
  currentCodeHash: string;
  upgraded: boolean;
  detectedAt: string;
}

export interface ContractUpgradeDetectionOptions {
  cache?: SorokitCache;
  onUpgrade?: (event: UpgradeEvent) => void;
}

function hashWasm(wasm: Uint8Array): string {
  return createHash("sha256").update(wasm).digest("hex");
}

function hashKey(contractId: string): string {
  return `${HASH_CACHE_PREFIX}${contractId}`;
}

function invalidateContractCaches(contractId: string, cache?: SorokitCache): void {
  invalidateContractCache(contractId, cache);
  cache?.invalidate(`sorokit:contract-schema:${contractId}`);
  cache?.invalidateByPrefix?.(`sorokit:contract-read:${contractId}:`);
  cache?.invalidateByPrefix?.(`sorokit:contract-state:${contractId}`);
  cache?.invalidateByPrefix?.(`sorokit:contract-metadata:${contractId}`);
}

/** Fetch the deployed Wasm hash and invalidate contract-scoped caches on change. */
export async function detectContractUpgrade(
  rpcUrl: string,
  contractId: string,
  options: ContractUpgradeDetectionOptions = {},
): Promise<SorokitResult<UpgradeEvent>> {
  try {
    const wasm = await fetchContractWasm(rpcUrl, contractId);
    if (wasm.status === "error") return wasm;

    const currentCodeHash = hashWasm(wasm.data);
    const previousValue = options.cache?.get(hashKey(contractId));
    const previousCodeHash = typeof previousValue === "string" ? previousValue : null;
    const upgraded = previousCodeHash !== null && previousCodeHash !== currentCodeHash;
    const event: UpgradeEvent = {
      contractId,
      previousCodeHash,
      currentCodeHash,
      upgraded,
      detectedAt: new Date().toISOString(),
    };

    if (upgraded) {
      invalidateContractCaches(contractId, options.cache);
      options.onUpgrade?.(event);
    }
    options.cache?.set(hashKey(contractId), currentCodeHash);
    return ok(event);
  } catch (cause) {
    return err(
      SorokitErrorCode.CONTRACT_READ_FAILED,
      `Failed to detect contract upgrade: ${toMessage(cause)}`,
      cause,
    );
  }
}
