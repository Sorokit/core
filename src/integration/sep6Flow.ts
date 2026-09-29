/**
 * SEP-6 Deposit and Withdrawal Flow - Anchor on/off ramps
 *
 * Implements SEP-6 for deposit and withdrawal flows with anchors. Handles
 * deposit initiation, withdrawal initiation, asset info retrieval, and
 * transaction tracking.
 */

import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { Asset } from "@stellar/stellar-sdk";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface AssetInfo {
  /** Asset code */
  assetCode: string;
  /** Asset issuer (null for native) */
  assetIssuer: string | null;
  /** Deposit enabled */
  depositEnabled: boolean;
  /** Withdrawal enabled */
  withdrawalEnabled: boolean;
  /** Deposit minimum amount */
  depositMinAmount?: string;
  /** Deposit maximum amount */
  depositMaxAmount?: string;
  /** Withdrawal minimum amount */
  withdrawMinAmount?: string;
  /** Withdrawal maximum amount */
  withdrawMaxAmount?: string;
  /** Deposit fee fixed */
  depositFeeFixed?: number;
  /** Deposit fee percent */
  depositFeePercent?: number;
  /** Withdrawal fee fixed */
  withdrawFeeFixed?: number;
  /** Withdrawal fee percent */
  withdrawFeePercent?: number;
}

export interface DepositRequest {
  /** Asset code */
  assetCode: string;
  /** Asset issuer (optional for native) */
  assetIssuer?: string;
  /** Stellar account public key */
  stellarAccount: string;
  /** Amount to deposit (optional) */
  amount?: string;
  /** Memo for the deposit (optional) */
  memo?: string;
  /** Memo type (optional) */
  memoType?: "text" | "id" | "hash" | "return";
  /** Additional fields as required by the anchor */
  [key: string]: unknown;
}

export interface DepositResponse {
  /** URL to redirect user to for deposit */
  url: string;
  /** Deposit ID for tracking */
  id: string;
  /** Amount to deposit */
  amountIn?: string;
  /** Amount to receive (in Stellar) */
  amountOut?: string;
  /** Fee charged */
  fee?: string;
  /** Memo for the deposit */
  memo?: string;
  /** Memo type */
  memoType?: string;
  /** When the deposit expires (ISO 8601 timestamp) */
  expiresAt?: string;
}

export interface WithdrawalRequest {
  /** Asset code */
  assetCode: string;
  /** Asset issuer (optional for native) */
  assetIssuer?: string;
  /** Stellar account public key */
  stellarAccount: string;
  /** Amount to withdraw */
  amount: string;
  /** Destination address (external) */
  dest: string;
  /** Memo for the withdrawal (optional) */
  memo?: string;
  /** Memo type (optional) */
  memoType?: "text" | "id" | "hash" | "return";
  /** Additional fields as required by the anchor */
  [key: string]: unknown;
}

export interface WithdrawalResponse {
  /** Withdrawal ID for tracking */
  id: string;
  /** Amount to withdraw (in Stellar) */
  amountIn: string;
  /** Amount to receive (external) */
  amountOut?: string;
  /** Fee charged */
  fee?: string;
  /** Destination address */
  dest: string;
  /** Memo for the withdrawal */
  memo?: string;
  /** Memo type */
  memoType?: string;
  /** When the withdrawal expires (ISO 8601 timestamp) */
  expiresAt?: string;
}

export interface TransactionInfo {
  /** Transaction ID */
  id: string;
  /** Stellar transaction ID */
  stellarTransactionId?: string;
  /** Transaction type */
  kind: "deposit" | "withdrawal";
  /** Transaction status */
  status: "pending" | "pending_user_transfer_start" | "pending_user_transfer_complete" | "pending_anchor" | "pending_trust" | "pending_kyc" | "pending_external" | "completed" | "refunded" | "no_market" | "too_small" | "too_large" | "error";
  /** Amount in */
  amountIn?: string;
  /** Amount in asset */
  amountInAsset?: string;
  /** Amount out */
  amountOut?: string;
  /** Amount out asset */
  amountOutAsset?: string;
  /** Fee charged */
  amountFee?: string;
  /** Fee asset */
  amountFeeAsset?: string;
  /** When the transaction was created (ISO 8601 timestamp) */
  startedAt: string;
  /** When the transaction was completed (ISO 8601 timestamp) */
  completedAt?: string;
  /** Transaction memo */
  memo?: string;
  /** Transaction memo type */
  memoType?: string;
  /** Error message if transaction failed */
  error?: string;
  /** Additional fields from the anchor */
  [key: string]: unknown;
}

// ─── Implementation ───────────────────────────────────────────────────────────

/**
 * Get information about supported assets from an anchor.
 *
 * @param serverUrl - The SEP-6 anchor server URL
 * @returns SorokitResult with array of asset info
 */
export async function getAssetInfo(
  serverUrl: string,
): Promise<SorokitResult<AssetInfo[]>> {
  try {
    if (!serverUrl || typeof serverUrl !== "string") {
      return err(
        SorokitErrorCode.VALIDATION,
        "getAssetInfo: serverUrl must be a non-empty string.",
      );
    }

    const url = new URL("/sep6/info", serverUrl);
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return err(
        SorokitErrorCode.NETWORK_ERROR,
        `SEP-6 info request failed: ${response.status} ${response.statusText}`,
        errorText,
      );
    }

    const data = await response.json();
    const assets = Array.isArray(data) ? data : [data];
    return ok(assets as AssetInfo[]);
  } catch (error) {
    return err(
      SorokitErrorCode.NETWORK_ERROR,
      `getAssetInfo: ${error instanceof Error ? error.message : "Unknown error"}`,
      error,
    );
  }
}

/**
 * Initiate a deposit flow with an anchor.
 *
 * @param serverUrl - The SEP-6 anchor server URL
 * @param request - Deposit request parameters
 * @returns SorokitResult with deposit response containing URL
 */
export async function initiateDeposit(
  serverUrl: string,
  request: DepositRequest,
): Promise<SorokitResult<DepositResponse>> {
  try {
    if (!serverUrl || typeof serverUrl !== "string") {
      return err(
        SorokitErrorCode.VALIDATION,
        "initiateDeposit: serverUrl must be a non-empty string.",
      );
    }

    if (!request.assetCode || !request.stellarAccount) {
      return err(
        SorokitErrorCode.VALIDATION,
        "initiateDeposit: assetCode and stellarAccount are required.",
      );
    }

    const url = new URL("/sep6/deposit", serverUrl);
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return err(
        SorokitErrorCode.NETWORK_ERROR,
        `SEP-6 deposit request failed: ${response.status} ${response.statusText}`,
        errorText,
      );
    }

    const data = await response.json();
    return ok(data as DepositResponse);
  } catch (error) {
    return err(
      SorokitErrorCode.NETWORK_ERROR,
      `initiateDeposit: ${error instanceof Error ? error.message : "Unknown error"}`,
      error,
    );
  }
}

/**
 * Initiate a withdrawal flow with an anchor.
 *
 * @param serverUrl - The SEP-6 anchor server URL
 * @param request - Withdrawal request parameters
 * @returns SorokitResult with withdrawal response
 */
export async function initiateWithdraw(
  serverUrl: string,
  request: WithdrawalRequest,
): Promise<SorokitResult<WithdrawalResponse>> {
  try {
    if (!serverUrl || typeof serverUrl !== "string") {
      return err(
        SorokitErrorCode.VALIDATION,
        "initiateWithdraw: serverUrl must be a non-empty string.",
      );
    }

    if (!request.assetCode || !request.stellarAccount || !request.amount || !request.dest) {
      return err(
        SorokitErrorCode.VALIDATION,
        "initiateWithdraw: assetCode, stellarAccount, amount, and dest are required.",
      );
    }

    const url = new URL("/sep6/withdraw", serverUrl);
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return err(
        SorokitErrorCode.NETWORK_ERROR,
        `SEP-6 withdrawal request failed: ${response.status} ${response.statusText}`,
        errorText,
      );
    }

    const data = await response.json();
    return ok(data as WithdrawalResponse);
  } catch (error) {
    return err(
      SorokitErrorCode.NETWORK_ERROR,
      `initiateWithdraw: ${error instanceof Error ? error.message : "Unknown error"}`,
      error,
    );
  }
}

/**
 * Track the status of a SEP-6 transaction.
 *
 * @param serverUrl - The SEP-6 anchor server URL
 * @param transactionId - The transaction ID to track
 * @param stellarAccount - The Stellar account associated with the transaction
 * @returns SorokitResult with transaction info
 */
export async function trackTransaction(
  serverUrl: string,
  transactionId: string,
  stellarAccount: string,
): Promise<SorokitResult<TransactionInfo>> {
  try {
    if (!serverUrl || typeof serverUrl !== "string") {
      return err(
        SorokitErrorCode.VALIDATION,
        "trackTransaction: serverUrl must be a non-empty string.",
      );
    }

    if (!transactionId || typeof transactionId !== "string") {
      return err(
        SorokitErrorCode.VALIDATION,
        "trackTransaction: transactionId must be a non-empty string.",
      );
    }

    if (!stellarAccount || typeof stellarAccount !== "string") {
      return err(
        SorokitErrorCode.VALIDATION,
        "trackTransaction: stellarAccount must be a non-empty string.",
      );
    }

    const url = new URL("/sep6/transaction", serverUrl);
    url.searchParams.append("id", transactionId);
    url.searchParams.append("stellar_account", stellarAccount);
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return err(
        SorokitErrorCode.NETWORK_ERROR,
        `SEP-6 transaction status request failed: ${response.status} ${response.statusText}`,
        errorText,
      );
    }

    const data = await response.json();
    return ok(data as TransactionInfo);
  } catch (error) {
    return err(
      SorokitErrorCode.NETWORK_ERROR,
      `trackTransaction: ${error instanceof Error ? error.message : "Unknown error"}`,
      error,
    );
  }
}

/**
 * Get all transactions for a Stellar account from an anchor.
 *
 * @param serverUrl - The SEP-6 anchor server URL
 * @param stellarAccount - The Stellar account to query
 * @returns SorokitResult with array of transaction info
 */
export async function getTransactions(
  serverUrl: string,
  stellarAccount: string,
): Promise<SorokitResult<TransactionInfo[]>> {
  try {
    if (!serverUrl || typeof serverUrl !== "string") {
      return err(
        SorokitErrorCode.VALIDATION,
        "getTransactions: serverUrl must be a non-empty string.",
      );
    }

    if (!stellarAccount || typeof stellarAccount !== "string") {
      return err(
        SorokitErrorCode.VALIDATION,
        "getTransactions: stellarAccount must be a non-empty string.",
      );
    }

    const url = new URL("/sep6/transactions", serverUrl);
    url.searchParams.append("stellar_account", stellarAccount);
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return err(
        SorokitErrorCode.NETWORK_ERROR,
        `SEP-6 transactions request failed: ${response.status} ${response.statusText}`,
        errorText,
      );
    }

    const data = await response.json();
    const transactions = Array.isArray(data.transactions) ? data.transactions : [];
    return ok(transactions as TransactionInfo[]);
  } catch (error) {
    return err(
      SorokitErrorCode.NETWORK_ERROR,
      `getTransactions: ${error instanceof Error ? error.message : "Unknown error"}`,
      error,
    );
  }
}
