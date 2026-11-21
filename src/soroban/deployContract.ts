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
import { mapRpcError } from "../shared/errorMapping";
import { DEFAULT_TX_TIMEOUT_SECONDS } from "../shared/constants";
import type { ResolvedNetworkConfig } from "../shared/types";
import type { PreparedContractCall } from "./types";
import { createHorizonServer, createSorobanServer } from "../shared/serverFactory";
import { validateDeployConfig } from "./validateDeployConfig";

const MAX_WASM_SIZE = 256 * 1024; // 256 KB

export interface BuildContractDeployOptions {
  rpcUrl: string;
  horizonUrl: string;
  networkConfig: ResolvedNetworkConfig;
  salt?: Buffer;
}

/**
 * Build a contract deployment transaction (upload WASM + create contract).
 *
 * The configuration is validated before any network call, so a missing endpoint,
 * an unresolved network config, or a malformed deployer address returns
 * `INVALID_CONFIG` naming each offending field and its fix instead of surfacing
 * later as an opaque RPC or Horizon failure. Valid configurations follow exactly
 * the same path as before.
 *
 * @param contractCode - Compiled contract WASM
 * @param deployer - Stellar public key (G...) funding and owning the deployment
 * @param options - RPC/Horizon endpoints, resolved network config, optional salt
 * @returns Assembled deployment XDR and fee, or a descriptive error
 *
 * @see validateDeployConfig — run the same checks from a deployment script
 */
export async function buildContractDeploy(
  contractCode: Buffer,
  deployer: string,
  options: BuildContractDeployOptions
): Promise<SorokitResult<PreparedContractCall>> {
  // Validate configuration before any network call so missing or malformed
  // values are reported as actionable errors instead of opaque RPC failures.
  const configResult = validateDeployConfig({
    rpcUrl: options?.rpcUrl,
    horizonUrl: options?.horizonUrl,
    networkConfig: options?.networkConfig,
    deployer,
    salt: options?.salt,
  });
  if (configResult.status === "error") return configResult;

  // Validate WASM presence — callers without type checking can reach here with
  // an unread or empty file buffer.
  if (!Buffer.isBuffer(contractCode) || contractCode.length === 0) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "Contract WASM is missing or empty. Pass the compiled .wasm file contents as a Buffer (e.g. fs.readFileSync(wasmPath))."
    );
  }

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
    const rpc = createSorobanServer(options.rpcUrl);
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
      wasmHash: wasmId,
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
    // Decode any numeric JSON-RPC 2.0 error code carried by the exception
    const rpcMapped = mapRpcError(cause);
    return err(
      rpcMapped.code,
      `Failed to build contract deployment: ${rpcMapped.message}`,
      cause
    );
  }
}
