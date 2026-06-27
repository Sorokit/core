import {
  rpc as SorobanRpc,
  TransactionBuilder,
  Contract,
  BASE_FEE,
  scValToNative,
  Horizon,
} from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage } from "../shared";
import { DEFAULT_TX_TIMEOUT_SECONDS } from "../shared/constants";
import type { ResolvedNetworkConfig } from "../shared/types";
import type { ContractReadParams, ContractCallResult } from "./types";
import { validateContractMethodMetadata } from "./contractMetadata";
import { validateContractAbi } from "./validateContractAbi";

/**
 * Read (simulate) a Soroban contract view function — no signing required.
 *
 * Validates the method signature against the provided ABI before simulating,
 * decodes the XDR result back to a native JS value, and wraps it in a
 * `ContractCallResult`. All network errors are returned as `SorokitResult`
 * errors rather than thrown.
 *
 * @param rpcUrl        - Base URL of the Soroban RPC server.
 * @param horizonUrl    - Base URL of the Horizon server.
 * @param networkConfig - Resolved network configuration.
 * @param params        - Contract read parameters: `contractId`, `publicKey`, `method`, `args`, `contractAbi`.
 * @returns `ok(ContractCallResult)` with the decoded return value,
 *          or `error(CONTRACT_READ_FAILED)` on failure.
 *
 * @example
 * const result = await readContract(rpcUrl, horizonUrl, networkConfig, {
 *   contractId: "CABC...",
 *   publicKey: "GSOURCE...",
 *   method: "balance",
 *   args: [],
 *   contractAbi: myAbi,
 * });
 * if (result.status === "ok") {
 *   console.log("Return value:", result.data.result);
 * }
 */
export async function readContract(
  rpcUrl: string,
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  params: ContractReadParams,
): Promise<SorokitResult<ContractCallResult>> {
  const abiValidation = validateContractAbi({
    contractAbi: params.contractAbi,
    method: params.method,
    argCount: params.args?.length ?? 0,
  });
  if (abiValidation.status === "error") {
    return err(
      SorokitErrorCode.CONTRACT_READ_FAILED,
      abiValidation.error.message,
      abiValidation.error.cause,
    );
  }

  const metadataResult = validateContractMethodMetadata(
    params.cachedMetadata,
    params.method,
    params.args?.length ?? 0,
    SorokitErrorCode.CONTRACT_READ_FAILED,
  );
  if (metadataResult.status === "error") return metadataResult;

  try {
    const rpc = new SorobanRpc.Server(rpcUrl);
    const horizonServer = new Horizon.Server(horizonUrl);
    const contract = new Contract(params.contractId);

    const sourceAccount = await horizonServer
      .loadAccount(params.publicKey)
      .catch((cause) => {
        throw new Error(
          `Could not load source account ${params.publicKey}: ${toMessage(cause)}`,
        );
      });

    const operation = contract.call(params.method, ...(params.args ?? []));

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: networkConfig.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(DEFAULT_TX_TIMEOUT_SECONDS)
      .build();

    const simResult = await rpc.simulateTransaction(tx);

    if (SorobanRpc.Api.isSimulationError(simResult)) {
      return err(
        SorokitErrorCode.CONTRACT_READ_FAILED,
        `Contract simulation error: ${simResult.error}`,
        simResult,
      );
    }

    if (!SorobanRpc.Api.isSimulationSuccess(simResult) || !simResult.result) {
      return err(
        SorokitErrorCode.CONTRACT_READ_FAILED,
        "Contract simulation returned no result.",
      );
    }

    const scVal = simResult.result.retval;
    return ok({ result: scVal, value: scValToNative(scVal) });
  } catch (cause) {
    return err(
      SorokitErrorCode.CONTRACT_READ_FAILED,
      `Failed to read contract: ${toMessage(cause)}`,
      cause,
    );
  }
}
