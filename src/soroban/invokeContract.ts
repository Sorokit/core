import { err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage } from "../shared";
import type { ResolvedNetworkConfig } from "../shared/types";
import type { ContractInvokeParams, SorobanPollConfig } from "./types";
import { prepareContractCall } from "./prepareCall";
import { executeContract } from "./executeContract";

/**
 * Full Soroban invoke pipeline: prepare → sign → execute
 *
 * Steps:
 * 1. prepareContractCall  — build + simulate + assemble the transaction
 * 2. signFn               — caller signs the assembled XDR (wallet-agnostic)
 * 3. executeContract      — submit to RPC + poll until confirmed
 *
 * Each step is a named, independently callable function.
 * Use them directly when you need finer control over the flow.
 *
 * @param signFn - Async function that receives an XDR string and returns the
 *                 signed XDR. Typically: (xdr) => client.wallet.signTransaction(adapter, { transactionXdr: xdr, networkPassphrase })
 * @param pollConfig - Override default polling behaviour for this call.
 *
 * Returns the confirmed transaction hash on success.
 */
export async function invokeContract(
  rpcUrl: string,
  networkConfig: ResolvedNetworkConfig,
  horizonUrl: string,
  params: ContractInvokeParams,
  signFn: (xdr: string) => Promise<string>,
  pollConfig?: SorobanPollConfig,
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
    signedXdr = await signFn(prepared.data.transactionXdr);
  } catch (cause) {
    return err(
      SorokitErrorCode.WALLET_SIGN_FAILED,
      `Signing failed during contract invocation: ${toMessage(cause)}`,
      cause,
    );
  }

  // ── Step 3: Execute ────────────────────────────────────────────────────────
  return executeContract(rpcUrl, networkConfig, signedXdr, pollConfig);
}
