/**
 * SAC (Stellar Asset Contract) Token Helpers
 *
 * Type-safe wrappers for common SAC operations: balance, transfer, and approve.
 * All amounts are strings with 7-decimal precision (Stellar standard).
 */

import {
  Address,
  BASE_FEE,
  Contract,
  Horizon,
  nativeToScVal,
  rpc as SorobanRpc,
  scValToNative,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { ResolvedNetworkConfig } from "../shared/types";
import { prepareContractCall } from "./prepareCall";
import type { ContractInvokeParams, PreparedContractCall } from "./types";
import { validatePublicKey } from "../shared/validation";
import { isValidContractId } from "../shared/utils";

/**
 * Get the SAC token balance for an account.
 *
 * @param rpcUrl        - Base URL of the Soroban RPC server.
 * @param horizonUrl    - Base URL of the Horizon server.
 * @param networkConfig - Resolved network configuration.
 * @param contractId    - The SAC contract ID.
 * @param account       - The account address to query balance for.
 * @returns `ok(balance)` as a string, or an error result.
 */
export async function getSacBalance(
  rpcUrl: string,
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  contractId: string,
  account: string,
): Promise<SorokitResult<string>> {
  // Validate contract ID
  if (!isValidContractId(contractId)) {
    return err(
      SorokitErrorCode.VALIDATION,
      `Invalid contract ID: '${contractId}'. Expected a C-prefixed 56-character Stellar base32 string.`,
    );
  }

  // Validate account address
  const accountResult = validatePublicKey(account);
  if (accountResult.status === "error") {
    return err(
      SorokitErrorCode.VALIDATION,
      `Invalid account address: ${accountResult.error.message}`,
    );
  }

  try {
    const contract = new Contract(contractId);
    const address = new Address(account);

    // SAC balance method: balance(address)
    const operation = contract.call("balance", address.toScVal());

    // Build transaction for simulation (read-only)
    const horizonServer = new Horizon.Server(horizonUrl, { allowHttp: networkConfig.network === "testnet" });
    const rpc = new SorobanRpc.Server(rpcUrl, { allowHttp: networkConfig.network === "testnet" });

    // Use a funded account for simulation
    const sourceAccount = await horizonServer.loadAccount(account);

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: networkConfig.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const simResult = await rpc.simulateTransaction(tx);

    if (SorobanRpc.Api.isSimulationError(simResult)) {
      return err(
        SorokitErrorCode.CONTRACT_READ_FAILED,
        `SAC balance simulation error: ${simResult.error}`,
      );
    }

    if (!SorobanRpc.Api.isSimulationSuccess(simResult) || !simResult.result) {
      return err(
        SorokitErrorCode.CONTRACT_READ_FAILED,
        "SAC balance simulation returned no result.",
      );
    }

    // Decode the balance (i128) to string
    const balanceScVal = simResult.result.retval;
    const balanceNative = scValToNative(balanceScVal);
    const balance = typeof balanceNative === "bigint" ? balanceNative : BigInt(balanceNative as number);
    
    // Convert to string with 7 decimal places
    const balanceStr = (Number(balance) / 10_000_000).toFixed(7);

    return ok(balanceStr);
  } catch (cause) {
    return err(
      SorokitErrorCode.CONTRACT_READ_FAILED,
      `Failed to get SAC balance: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    );
  }
}

/**
 * Build a prepared SAC transfer call.
 *
 * @param rpcUrl        - Base URL of the Soroban RPC server.
 * @param networkConfig - Resolved network configuration.
 * @param horizonUrl    - Base URL of the Horizon server.
 * @param contractId    - The SAC contract ID.
 * @param from          - The sender's public key.
 * @param to            - The recipient's address.
 * @param amount        - The amount to transfer (string with 7-decimal precision).
 * @returns `ok(PreparedContractCall)` ready for signing, or an error result.
 */
export async function buildSacTransfer(
  rpcUrl: string,
  networkConfig: ResolvedNetworkConfig,
  horizonUrl: string,
  contractId: string,
  from: string,
  to: string,
  amount: string,
): Promise<SorokitResult<PreparedContractCall>> {
  // Validate contract ID
  if (!isValidContractId(contractId)) {
    return err(
      SorokitErrorCode.VALIDATION,
      `Invalid contract ID: '${contractId}'. Expected a C-prefixed 56-character Stellar base32 string.`,
    );
  }

  // Validate from address
  const fromResult = validatePublicKey(from);
  if (fromResult.status === "error") {
    return err(
      SorokitErrorCode.VALIDATION,
      `Invalid from address: ${fromResult.error.message}`,
    );
  }

  // Validate to address
  const toResult = validatePublicKey(to);
  if (toResult.status === "error") {
    return err(
      SorokitErrorCode.VALIDATION,
      `Invalid to address: ${toResult.error.message}`,
    );
  }

  // Validate amount format
  const amountValidation = validateTokenAmount(amount);
  if (amountValidation.status === "error") {
    return amountValidation;
  }

  try {
    // Convert amount to i128 (7 decimal places)
    const amountBigint = stringToI128(amount);
    const amountScVal = nativeToScVal(amountBigint, { type: "i128" });

    const fromAddress = new Address(from);
    const toAddress = new Address(to);

    // SAC transfer method: transfer(from, to, amount_i128)
    const contract = new Contract(contractId);
    const operation = contract.call(
      "transfer",
      fromAddress.toScVal(),
      toAddress.toScVal(),
      amountScVal,
    );

    const params: ContractInvokeParams = {
      contractId,
      method: "transfer",
      args: [fromAddress.toScVal(), toAddress.toScVal(), amountScVal],
      publicKey: from,
    };

    return await prepareContractCall(rpcUrl, networkConfig, horizonUrl, params);
  } catch (cause) {
    return err(
      SorokitErrorCode.CONTRACT_PREPARE_FAILED,
      `Failed to build SAC transfer: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    );
  }
}

/**
 * Build a prepared SAC approve call.
 *
 * @param rpcUrl        - Base URL of the Soroban RPC server.
 * @param networkConfig - Resolved network configuration.
 * @param horizonUrl    - Base URL of the Horizon server.
 * @param contractId    - The SAC contract ID.
 * @param owner         - The token owner's public key.
 * @param spender       - The address to approve for spending.
 * @param amount        - The amount to approve (string with 7-decimal precision).
 * @returns `ok(PreparedContractCall)` ready for signing, or an error result.
 */
export async function buildSacApprove(
  rpcUrl: string,
  networkConfig: ResolvedNetworkConfig,
  horizonUrl: string,
  contractId: string,
  owner: string,
  spender: string,
  amount: string,
): Promise<SorokitResult<PreparedContractCall>> {
  // Validate contract ID
  if (!isValidContractId(contractId)) {
    return err(
      SorokitErrorCode.VALIDATION,
      `Invalid contract ID: '${contractId}'. Expected a C-prefixed 56-character Stellar base32 string.`,
    );
  }

  // Validate owner address
  const ownerResult = validatePublicKey(owner);
  if (ownerResult.status === "error") {
    return err(
      SorokitErrorCode.VALIDATION,
      `Invalid owner address: ${ownerResult.error.message}`,
    );
  }

  // Validate spender address
  const spenderResult = validatePublicKey(spender);
  if (spenderResult.status === "error") {
    return err(
      SorokitErrorCode.VALIDATION,
      `Invalid spender address: ${spenderResult.error.message}`,
    );
  }

  // Validate amount format
  const amountValidation = validateTokenAmount(amount);
  if (amountValidation.status === "error") {
    return amountValidation;
  }

  try {
    // Convert amount to i128 (7 decimal places)
    const amountBigint = stringToI128(amount);
    const amountScVal = nativeToScVal(amountBigint, { type: "i128" });

    const ownerAddress = new Address(owner);
    const spenderAddress = new Address(spender);

    // SAC approve method: approve(from, spender, amount_i128, expiration_ledger)
    // Using 0 for expiration_ledger (no expiration)
    const expirationLedger = nativeToScVal(0n, { type: "u32" });

    const contract = new Contract(contractId);
    const operation = contract.call(
      "approve",
      ownerAddress.toScVal(),
      spenderAddress.toScVal(),
      amountScVal,
      expirationLedger,
    );

    const params: ContractInvokeParams = {
      contractId,
      method: "approve",
      args: [
        ownerAddress.toScVal(),
        spenderAddress.toScVal(),
        amountScVal,
        expirationLedger,
      ],
      publicKey: owner,
    };

    return await prepareContractCall(rpcUrl, networkConfig, horizonUrl, params);
  } catch (cause) {
    return err(
      SorokitErrorCode.CONTRACT_PREPARE_FAILED,
      `Failed to build SAC approve: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    );
  }
}

/**
 * Validate token amount format (7-decimal precision).
 */
function validateTokenAmount(amount: string): SorokitResult<void> {
  if (typeof amount !== "string") {
    return err(
      SorokitErrorCode.VALIDATION,
      "Amount must be a string.",
    );
  }

  const num = Number(amount);
  if (isNaN(num)) {
    return err(
      SorokitErrorCode.VALIDATION,
      "Amount must be a valid number.",
    );
  }

  if (num < 0) {
    return err(
      SorokitErrorCode.VALIDATION,
      "Amount must be non-negative.",
    );
  }

  // Check decimal places
  const decimalIndex = amount.indexOf(".");
  if (decimalIndex !== -1) {
    const decimalPlaces = amount.length - decimalIndex - 1;
    if (decimalPlaces > 7) {
      return err(
        SorokitErrorCode.VALIDATION,
        "Amount must have at most 7 decimal places.",
      );
    }
  }

  return ok(undefined);
}

/**
 * Convert a string amount to i128 bigint (7 decimal places).
 */
function stringToI128(amount: string): bigint {
  const num = Number(amount);
  const scaled = Math.round(num * 10000000);
  return BigInt(scaled);
}
