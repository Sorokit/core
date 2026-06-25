import {
  rpc as SorobanRpc,
  TransactionBuilder,
  Operation,
  BASE_FEE,
  Horizon,
  Address,
} from "@stellar/stellar-sdk";
import crypto from "crypto";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import {
  isNetworkConnectivityError,
  isTimeoutError,
  retryWithBackoff,
  toMessage,
} from "../shared";
import { DEFAULT_TX_TIMEOUT_SECONDS } from "../shared/constants";
import type { ResolvedNetworkConfig } from "../shared/types";
import type { PreparedContractCall } from "./types";

const MAX_WASM_SIZE = 256 * 1024; // 256 KB

export interface BuildContractDeployOptions {
  rpcUrl: string;
  horizonUrl: string;
  networkConfig: ResolvedNetworkConfig;
  salt?: Buffer;
}

export async function buildContractDeploy(
  contractCode: Buffer,
  deployer: string,
  options: BuildContractDeployOptions
): Promise<SorokitResult<PreparedContractCall>> {
  // Validate WASM size
  if (contractCode.length > MAX_WASM_SIZE) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `WASM code exceeds max size of ${MAX_WASM_SIZE} bytes`
    );
  }

  // Validate WASM magic number (0x00, 0x61, 0x73, 0x6d)
  if (
    contractCode.length < 4 ||
    contractCode[0] !== 0x00 ||
    contractCode[1] !== 0x61 ||
    contractCode[2] !== 0x73 ||
    contractCode[3] !== 0x6d
  ) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "Invalid WASM format: missing magic bytes"
    );
  }

  try {
    const rpc = new SorobanRpc.Server(options.rpcUrl);
    const horizonServer = new Horizon.Server(options.horizonUrl);

    // Get deployer account for sequence number
    const sourceAccount = await horizonServer.loadAccount(deployer);

    // Upload WASM operation
    const uploadOp = Operation.uploadContractWasm({
      wasm: contractCode,
    });

    // Compute WASM ID (SHA-256 hash of WASM code)
    const wasmId = crypto.createHash("sha256").update(contractCode).digest();

    // Create contract operation
    const salt = options.salt || crypto.randomBytes(32);
    const createOp = Operation.createCustomContract({
      address: new Address(deployer),
      wasmId,
      salt,
    });

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: options.networkConfig.networkPassphrase,
    })
      .addOperation(uploadOp)
      .addOperation(createOp)
      .setTimeout(DEFAULT_TX_TIMEOUT_SECONDS)
      .build();

    const simResult = await retryWithBackoff(async () => {
      return await rpc.simulateTransaction(tx);
    });

    if (SorobanRpc.Api.isSimulationError(simResult)) {
      return err(
        SorokitErrorCode.TX_SIMULATE_FAILED,
        `Contract deploy simulation error: ${simResult.error}`,
        simResult
      );
    }

    if (!SorobanRpc.Api.isSimulationSuccess(simResult)) {
      return err(
        SorokitErrorCode.TX_SIMULATE_FAILED,
        "Contract deploy simulation did not succeed."
      );
    }

    const assembled = SorobanRpc.assembleTransaction(tx, simResult).build();

    return ok({
      transactionXdr: assembled.toXDR(),
      fee: assembled.fee,
    });
  } catch (cause) {
    if (isTimeoutError(cause)) {
      return err(
        SorokitErrorCode.TX_SIMULATE_FAILED,
        `Contract deployment timed out while contacting RPC: ${toMessage(cause)}`,
        cause
      );
    }
    if (isNetworkConnectivityError(cause)) {
      return err(
        SorokitErrorCode.TX_SIMULATE_FAILED,
        `Contract deployment failed due to network connectivity: ${toMessage(cause)}`,
        cause
      );
    }
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Failed to build contract deployment: ${toMessage(cause)}`,
      cause
    );
  }
}
