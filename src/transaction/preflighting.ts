/**
 * Transaction Preflighting (#952).
 *
 * Before submitting a transaction, preflight checks:
 * 1. Verify sequence matches account sequence
 * 2. Estimate fees
 * 3. Check account balance is sufficient for fee and operations
 *
 * Prevents transaction submission failures and warns on low balance.
 */

import {
  Transaction,
  FeeBumpTransaction,
  TransactionBuilder,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage } from "../shared";
import { getAccount } from "../account/getAccount";
import type { AccountInfo } from "../account/types";
import { estimateFee } from "./estimateFee";
import { MIN_ACCOUNT_BALANCE_XLM } from "../shared/constants";
import { NETWORK_DEFAULTS } from "../network/config";

export interface PreflightData {
  sequenceValid: boolean;
  expectedSequence: string;
  currentSequence: string;
  estimatedFee: string;
  currentBalance: string;
  sufficientBalance: boolean;
  warnings: string[];
}

export interface PreflightOptions {
  horizonUrl?: string;
  networkPassphrase?: string;
  account?: AccountInfo;
  estimatedFee?: string;
  minBalanceReserve?: string;
  signal?: AbortSignal;
}

/**
 * Preflight a transaction prior to submission.
 * Validates sequence number, estimates fee, and checks native XLM balance.
 *
 * @param tx - Stellar Transaction, FeeBumpTransaction, XDR string, or object with sequence/fee.
 * @param publicKey - Account public key.
 * @param options - Optional configuration (mock account, custom horizon URL, etc.).
 * @returns SorokitResult<PreflightData>
 */
export async function preflightTransaction(
  tx:
    | Transaction
    | FeeBumpTransaction
    | string
    | { sequence?: string | bigint | number; fee?: string | number },
  publicKey: string,
  options?: PreflightOptions,
): Promise<SorokitResult<PreflightData>> {
  try {
    const horizonUrl =
      options?.horizonUrl ?? NETWORK_DEFAULTS.testnet.horizonUrl;
    const networkPassphrase =
      options?.networkPassphrase ?? NETWORK_DEFAULTS.testnet.networkPassphrase;

    // 1. Fetch or resolve account
    let account: AccountInfo;
    if (options?.account) {
      account = options.account;
    } else {
      const accountRes = await getAccount(horizonUrl, publicKey, {
        signal: options?.signal,
      });
      if (accountRes.status === "error") {
        return err(
          SorokitErrorCode.ACCOUNT_FETCH_FAILED,
          `Preflight failed to fetch account: ${accountRes.error.message}`,
          accountRes.error.cause,
        );
      }
      account = accountRes.data;
    }

    const currentSequence = account.sequence.toString();
    const expectedSequence = (BigInt(currentSequence) + 1n).toString();

    // 2. Resolve transaction sequence & fee
    let txSequence: string | undefined;
    let txFee: string | undefined;
    let totalPaymentAmountXlm = 0;

    if (typeof tx === "string") {
      try {
        const parsed = TransactionBuilder.fromXDR(tx, networkPassphrase);
        if (parsed instanceof Transaction) {
          txSequence = parsed.sequence?.toString();
          txFee = parsed.fee?.toString();
          for (const op of parsed.operations) {
            if (op.type === "payment" && (!op.asset || op.asset.isNative())) {
              totalPaymentAmountXlm += parseFloat(op.amount || "0");
            }
          }
        } else if (parsed instanceof FeeBumpTransaction) {
          txFee = parsed.fee?.toString();
          txSequence = parsed.innerTransaction?.sequence?.toString();
        }
      } catch {
        // If string is raw or invalid XDR, continue gracefully
      }
    } else if (tx instanceof Transaction) {
      txSequence = tx.sequence?.toString();
      txFee = tx.fee?.toString();
      for (const op of tx.operations) {
        if (op.type === "payment" && (!op.asset || op.asset.isNative())) {
          totalPaymentAmountXlm += parseFloat(op.amount || "0");
        }
      }
    } else if (tx instanceof FeeBumpTransaction) {
      txFee = tx.fee?.toString();
      txSequence = tx.innerTransaction?.sequence?.toString();
    } else if (typeof tx === "object" && tx !== null) {
      if (tx.sequence !== undefined) {
        txSequence = tx.sequence.toString();
      }
      if (tx.fee !== undefined) {
        txFee = tx.fee.toString();
      }
    }

    // 3. Sequence Validation
    const sequenceValid =
      txSequence === undefined ||
      txSequence === expectedSequence ||
      txSequence === currentSequence;

    // 4. Estimate Fee
    let estimatedFee = options?.estimatedFee ?? txFee;
    if (!estimatedFee) {
      try {
        const feeRes = await estimateFee(horizonUrl, {
          network: "testnet",
          horizonUrl,
          networkPassphrase,
        });
        if (feeRes.status === "ok") {
          estimatedFee = feeRes.data.fee;
        } else {
          estimatedFee = BASE_FEE;
        }
      } catch {
        estimatedFee = BASE_FEE;
      }
    }

    // 5. Balance check
    const nativeEntry = account.balances?.find((b) => b.assetType === "native");
    const currentBalance = nativeEntry ? nativeEntry.balance : "0";
    const currentBalanceNum = parseFloat(currentBalance) || 0;

    // Stellar fees in stroops (1 XLM = 10,000,000 stroops)
    const feeInStroops = parseFloat(estimatedFee) || 100;
    const feeInXlm = feeInStroops / 10_000_000;
    const requiredXlm = totalPaymentAmountXlm + feeInXlm;
    const minReserve = parseFloat(
      options?.minBalanceReserve ?? MIN_ACCOUNT_BALANCE_XLM,
    );

    const sufficientBalance = currentBalanceNum >= requiredXlm;
    const warnings: string[] = [];

    if (!sufficientBalance) {
      warnings.push(
        `Insufficient balance: account has ${currentBalance} XLM, requires at least ${requiredXlm.toFixed(7)} XLM (fee: ${feeInXlm.toFixed(7)} XLM).`,
      );
    } else if (currentBalanceNum - requiredXlm < minReserve) {
      warnings.push(
        `Low balance warning: remaining balance (${(currentBalanceNum - requiredXlm).toFixed(7)} XLM) will fall below or close to the minimum reserve of ${minReserve} XLM.`,
      );
    }

    if (!sequenceValid && txSequence !== undefined) {
      warnings.push(
        `Sequence mismatch: transaction has sequence ${txSequence}, expected ${expectedSequence}.`,
      );
    }

    return ok({
      sequenceValid,
      expectedSequence,
      currentSequence,
      estimatedFee,
      currentBalance,
      sufficientBalance,
      warnings,
    });
  } catch (cause) {
    return err(
      SorokitErrorCode.TRANSACTION_VALIDATION_FAILED,
      `Transaction preflighting failed: ${toMessage(cause)}`,
      cause,
    );
  }
}
