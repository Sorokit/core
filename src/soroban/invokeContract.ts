import type { MainnetSafetyOptions } from "../shared/mainnetSafety";
import { err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage } from "../shared";
import { profileOperation } from "../shared/metrics";
import type { SorokitLogger } from "../shared/logger";
import type { ResolvedNetworkConfig } from "../shared/types";
import type { ContractInvokeParams, SorobanPollConfig } from "./types";
import { prepareContractCall } from "./prepareCall";
import { executeContract, validateSorobanPollConfig } from "./executeContract";

/**
 * Options for invokeContract().
 */
export interface InvokeContractOptions extends MainnetSafetyOptions {
  /**
   * When true, emits detailed diagnostic logs at every pipeline stage:
   * - prepared call XDR and estimated fee
   * - simulation result summary
   * - submission attempt details
   * - final confirmed result or error
   *
   * Requires a `logger` to be passed alongside — debug output is written at
   * the `debug` level so it is invisible when the logger level is set higher.
   * (issue #194)
   */
  debugMode?: boolean;
}

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
 * @param params        - Contract invocation parameters.
 * @param signFn        - Async function that receives assembled XDR and returns signed XDR.
 * @param pollConfig    - Optional overrides for RPC polling behaviour.
 * @param logger        - Optional logger for diagnostic output.
 * @param invokeOptions - Optional flags including `debugMode`.
 * @returns `ok(txHash)` on success, or an error result.
 */
export async function invokeContract(
  rpcUrl: string,
  networkConfig: ResolvedNetworkConfig,
  horizonUrl: string,
  params: ContractInvokeParams,
  signFn: (xdr: string) => Promise<string>,
  pollConfig?: SorobanPollConfig,
  logger?: SorokitLogger,
  invokeOptions?: InvokeContractOptions,
): Promise<SorokitResult<string>> {
  return profileOperation("soroban.invokeContract", () =>
    invokeContractInner(
      rpcUrl,
      networkConfig,
      horizonUrl,
      params,
      signFn,
      pollConfig,
      logger,
      invokeOptions,
    ),
  );
}

async function invokeContractInner(
  rpcUrl: string,
  networkConfig: ResolvedNetworkConfig,
  horizonUrl: string,
  params: ContractInvokeParams,
  signFn: (xdr: string) => Promise<string>,
  pollConfig?: SorobanPollConfig,
  logger?: SorokitLogger,
  invokeOptions?: InvokeContractOptions,
): Promise<SorokitResult<string>> {
  const debug = invokeOptions?.debugMode === true;
  const pollErr = validateSorobanPollConfig(pollConfig);
  if (pollErr) return pollErr;

  // ── Step 1: Prepare ────────────────────────────────────────────────────────
  if (debug) {
    logger?.debug("soroban.invoke.prepare", {
      operation: "soroban.invoke.prepare",
      status: "start",
      contractId: params.contractId,
      method: params.method,
      argCount: params.args?.length ?? 0,
    });
  }

  const prepared = await prepareContractCall(
    rpcUrl,
    networkConfig,
    horizonUrl,
    params,
  );

  if (prepared.status === "error") {
    if (debug) {
      logger?.debug("soroban.invoke.prepare", {
        operation: "soroban.invoke.prepare",
        status: "error",
        contractId: params.contractId,
        method: params.method,
        errorCode: prepared.error.code,
        errorMessage: prepared.error.message,
      });
    }
    return prepared;
  }

  if (debug) {
    logger?.debug("soroban.invoke.prepare", {
      operation: "soroban.invoke.prepare",
      status: "ok",
      contractId: params.contractId,
      method: params.method,
      preparedXdr: prepared.data.transactionXdr,
      estimatedFee: prepared.data.fee,
    });
  }

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
    if (typeof signedXdr !== "string" || signedXdr.trim().length === 0) {
      const message = "signFn returned an empty or invalid XDR string.";
      logger?.warn("soroban.invoke.sign", {
        operation: "soroban.invoke.sign",
        status: "error",
        contractId: params.contractId,
        method: params.method,
        errorMessage: message,
      });
      return err(SorokitErrorCode.WALLET_SIGN_FAILED, message);
    }
    logger?.info("soroban.invoke.sign", {
      operation: "soroban.invoke.sign",
      status: "ok",
      contractId: params.contractId,
      method: params.method,
    });

    if (debug) {
      logger?.debug("soroban.invoke.sign", {
        operation: "soroban.invoke.sign",
        status: "debug",
        contractId: params.contractId,
        method: params.method,
        signedXdr,
      });
    }
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
  if (debug) {
    logger?.debug("soroban.invoke.execute", {
      operation: "soroban.invoke.execute",
      status: "start",
      contractId: params.contractId,
      method: params.method,
      rpcUrl,
      network: networkConfig.network,
    });
  }

  const result = await executeContract(
    rpcUrl,
    networkConfig,
    signedXdr,
    pollConfig,
    logger,
    params.stateTracker,
    invokeOptions,
  );

  if (debug) {
    if (result.status === "ok") {
      logger?.debug("soroban.invoke.execute", {
        operation: "soroban.invoke.execute",
        status: "ok",
        contractId: params.contractId,
        method: params.method,
        txHash: result.data,
      });
    } else {
      logger?.debug("soroban.invoke.execute", {
        operation: "soroban.invoke.execute",
        status: "error",
        contractId: params.contractId,
        method: params.method,
        errorCode: result.error.code,
        errorMessage: result.error.message,
      });
    }
  }

  return result;
}
