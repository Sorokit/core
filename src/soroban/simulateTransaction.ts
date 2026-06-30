import { rpc as SorobanRpc, TransactionBuilder, Address } from "@stellar/stellar-sdk";
import { createHash } from "crypto";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import {
  isNetworkConnectivityError,
  isTimeoutError,
  isXdrInvalidError,
  toMessage,
} from "../shared";
import type { SimulateTransactionResult } from "./types";
import type { SorokitCache } from "../shared/cache";

export interface SimulateTransactionOptions {
  cache?: SorokitCache;
  ttlMs?: number;
}

function tryGetCacheKey(
  transactionXdr: string,
  networkPassphrase: string,
): string | undefined {
  try {
    const tx = TransactionBuilder.fromXDR(transactionXdr, networkPassphrase);
    if (!("operations" in tx)) return undefined;

    const op = tx.operations.find((o) => o.type === "invokeHostFunction");
    if (!op) return undefined;

    const hostFn = (op as any).func;
    if (!hostFn || hostFn.arm() !== "invokeContract") return undefined;

    const invokeArgs = hostFn.invokeContract();
    const scAddr = invokeArgs.contractAddress();
    const contractId = Address.fromScAddress(scAddr).toString();
    const method = invokeArgs.functionName().toString("utf8");
    const argsXdr = invokeArgs.args().map((arg: any) => arg.toXDR("base64")).join("");

    const inputString = contractId + method + argsXdr;
    return createHash("sha256").update(inputString).digest("hex");
  } catch {
    return undefined;
  }
}

function describeSimulationFailure(cause: unknown): string {
  if (isXdrInvalidError(cause)) {
    return `Transaction simulation failed because the transaction XDR is malformed: ${toMessage(cause)}`;
  }
  if (isTimeoutError(cause)) {
    return `Transaction simulation timed out while contacting RPC: ${toMessage(cause)}`;
  }
  if (isNetworkConnectivityError(cause)) {
    return `Transaction simulation failed due to network connectivity: ${toMessage(cause)}`;
  }
  return `Transaction simulation failed: ${toMessage(cause)}`;
}

/**
 * Simulate any transaction XDR against the Soroban RPC.
 * Used for fee estimation and pre-flight validation without submitting.
 *
 * Lives in soroban/ because it uses the Soroban RPC server.
 * For contract calls, prefer soroban.prepare() which handles
 * simulation and assembly in one step.
 */
export async function simulateTransaction(
  rpcUrl: string,
  networkPassphrase: string,
  transactionXdr: string,
  options?: SimulateTransactionOptions,
): Promise<SorokitResult<SimulateTransactionResult>> {
  if (isXdrInvalidError(transactionXdr)) {
    return err(
      SorokitErrorCode.TX_SIMULATE_FAILED,
      "Transaction simulation failed because the transaction XDR is malformed.",
      transactionXdr,
    );
  }

  const cache = options?.cache;
  const cacheKey = cache ? tryGetCacheKey(transactionXdr, networkPassphrase) : undefined;

  if (cache && cacheKey) {
    const cached = cache.get(cacheKey);
    if (cached != null) {
      return ok(cached as SimulateTransactionResult);
    }
  }

  try {
    const rpc = new SorobanRpc.Server(rpcUrl);
    const tx = TransactionBuilder.fromXDR(transactionXdr, networkPassphrase);
    const simResult = await rpc.simulateTransaction(tx);

    if (SorobanRpc.Api.isSimulationError(simResult)) {
      const result: SimulateTransactionResult = { success: false, fee: "0", error: simResult.error };
      if (cache && cacheKey) {
        const ttlMs = options?.ttlMs ?? 5 * 60 * 1000;
        cache.set(cacheKey, result, ttlMs);
      }
      return ok(result);
    }

    if (SorobanRpc.Api.isSimulationSuccess(simResult)) {
      const result: SimulateTransactionResult = { success: true, fee: simResult.minResourceFee ?? "0" };
      if (cache && cacheKey) {
        const ttlMs = options?.ttlMs ?? 5 * 60 * 1000;
        cache.set(cacheKey, result, ttlMs);
      }
      return ok(result);
    }

    return err(
      SorokitErrorCode.TX_SIMULATE_FAILED,
      "Transaction simulation returned an unexpected result.",
      simResult,
    );
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_SIMULATE_FAILED,
      describeSimulationFailure(cause),
      cause,
    );
  }
}

