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
 * Read contract data — view/read-only call, no signing required.
 *
 * Simulates the contract call and returns the decoded result.
 * Requires a funded `publicKey` in params as the simulation source account.
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
