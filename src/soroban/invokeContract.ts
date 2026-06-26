import { err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage } from "../shared";
import type { SorokitLogger } from "../shared/logger";
import type { ResolvedNetworkConfig } from "../shared/types";
import type { ContractInvokeParams, SorobanPollConfig } from "./types";
import { prepareContractCall } from "./prepareCall";
import { executeContract } from "./executeContract";

/**
 * Full Soroban contract invoke pipeline: prepare → sign → execute.
 *
 * Runs three steps sequentially:
 * 1. `prepareContractCall` — builds, simulates, and assembles the transaction XDR.
 * 2. `signFn` — caller-supplied signing function (wallet-agnostic).
 * 3. `executeContract` — submits to the RPC node and polls until confirmed.
 *
 * Use the individual pipeline steps directly when you need finer control over
 * the flow (e.g., to inspect the prepared XDR before signing).
 *
 * @param rpcUrl        - Base URL of the Soroban RPC server.
 * @param networkConfig - Resolved network configuration.
 * @param horizonUrl    - Base URL of the Horizon server.
 * @param params        - Contract invocation parameters: `contractId`, `publicKey`, `method`, `args`, `contractAbi`.
 * @param signFn        - Async function that receives the assembled XDR string and
 *                        returns the signed XDR. Example:
 *                        `(xdr) => signTransaction(adapter, { transactionXdr: xdr, networkPassphrase })`
 * @param pollConfig    - Optional overrides for RPC polling behaviour.
 * @param logger        - Optional logger for diagnostic output.
 * @returns `ok(txHash)` — confirmed transaction hash on success,
 *          `error(WALLET_SIGN_FAILED)` if `signFn` throws,
 *          or `error(CONTRACT_INVOKE_FAILED)` on prepare/execute failure.
 *
 * @example
 * const result = await invokeContract(
 *   rpcUrl, networkConfig, horizonUrl,
 *   { contractId: "CABC...", publicKey: "GSRC...", method: "transfer", args: [...], contractAbi: myAbi },
 *   async (xdr) => {
 *     const signed = await signTransaction(adapter, { transactionXdr: xdr, networkPassphrase });
 *     if (signed.status === "error") throw new Error(signed.error.message);
 *     return signed.data;
 *   },
 * );
 * if (result.status === "ok") console.log("tx hash:", result.data);
 */
export async function invokeContract(
  rpcUrl: string,
  networkConfig: ResolvedNetworkConfig,
  horizonUrl: string,
  params: ContractInvokeParams,
  signFn: (xdr: string) => Promise<string>,
  pollConfig?: SorobanPollConfig,
  logger?: SorokitLogger,
): Promise<SorokitResult<string>> {
  // ── Step 1: Prepare ────────────────────────────────────────────────────────
  const prepared = await prepareContractCall(
    rpcUrl,
    networkConfig,
    horizonUrl,
    params,
  );
  if (prepared.status === "error") return prepared;

  // ── Step 2: Sign ───────────────────────────────────────────────────────────
  let signedXdr: string;
  try {
    logger?.debug("soroban.invoke.sign", {
      operation: "soroban.invoke.sign",
      status: "start",
      contractId: params.contractId,
      method: params.method,
    });
    signedXdr = await signFn(prepared.data.transactionXdr);
    logger?.info("soroban.invoke.sign", {
      operation: "soroban.invoke.sign",
      status: "ok",
      contractId: params.contractId,
      method: params.method,
    });
  } catch (cause) {
    const message = `Signing failed during contract invocation: ${toMessage(cause)}`;
    logger?.warn("soroban.invoke.sign", {
      operation: "soroban.invoke.sign",
      status: "error",
      contractId: params.contractId,
      method: params.method,
      errorMessage: message,
    });
    return err(SorokitErrorCode.WALLET_SIGN_FAILED, message, cause);
  }

  // ── Step 3: Execute ────────────────────────────────────────────────────────
  return executeContract(rpcUrl, networkConfig, signedXdr, pollConfig, logger);
}
