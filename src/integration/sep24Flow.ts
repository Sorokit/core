/**
 * SEP-24 Interactive Deposit and Withdrawal
 *
 * Implements SEP-24 for interactive web/mobile UI for deposit/withdrawal flows.
 * Handles flow initiation, popup/redirect management, and transaction monitoring.
 */

import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { Asset } from "@stellar/stellar-sdk";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface InteractiveAssetInfo {
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

export interface InteractiveDepositRequest {
  /** Asset code */
  assetCode: string;
  /** Asset issuer (optional for native) */
  assetIssuer?: string;
  /** Stellar account public key */
  stellarAccount: string;
  /** Amount to deposit (optional) */
  amount?: string;
  /** Claimable balance supported */
  claimableBalanceSupported?: boolean;
  /** Callback URL for the anchor to redirect to */
  callback?: string;
  /** Additional fields as required by the anchor */
  [key: string]: unknown;
}

export interface InteractiveDepositResponse {
  /** URL to open the interactive flow */
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

export interface InteractiveWithdrawalRequest {
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
  /** Callback URL for the anchor to redirect to */
  callback?: string;
  /** Additional fields as required by the anchor */
  [key: string]: unknown;
}

export interface InteractiveWithdrawalResponse {
  /** URL to open the interactive flow */
  url: string;
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

export interface InteractiveTransactionInfo {
  /** Transaction ID */
  id: string;
  /** Stellar transaction ID */
  stellarTransactionId?: string;
  /** Transaction type */
  kind: "deposit" | "withdrawal";
  /** Transaction status */
  status: "incomplete" | "pending_user_transfer_start" | "pending_user_transfer_complete" | "pending_anchor" | "pending_trust" | "pending_kyc" | "pending_external" | "completed" | "refunded" | "no_market" | "too_small" | "too_large" | "error";
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
  /** Interactive flow URL */
  interactiveUrl?: string;
  /** Additional fields from the anchor */
  [key: string]: unknown;
}

export interface InteractiveFlowConfig {
  /** Whether to use popup mode (default: true) */
  usePopup?: boolean;
  /** Popup window width (default: 600) */
  popupWidth?: number;
  /** Popup window height (default: 700) */
  popupHeight?: number;
  /** Callback URL for redirect mode */
  callback?: string;
}

// ─── Implementation ───────────────────────────────────────────────────────────

/**
 * Get information about supported assets from an anchor for interactive flows.
 *
 * @param serverUrl - The SEP-24 anchor server URL
 * @returns SorokitResult with array of asset info
 */
export async function getInteractiveAssetInfo(
  serverUrl: string,
): Promise<SorokitResult<InteractiveAssetInfo[]>> {
  try {
    if (!serverUrl || typeof serverUrl !== "string") {
      return err(
        SorokitErrorCode.VALIDATION,
        "getInteractiveAssetInfo: serverUrl must be a non-empty string.",
      );
    }

    const url = new URL("/sep24/info", serverUrl);
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
        `SEP-24 info request failed: ${response.status} ${response.statusText}`,
        errorText,
      );
    }

    const data = await response.json();
    const assets = Array.isArray(data) ? data : [data];
    return ok(assets as InteractiveAssetInfo[]);
  } catch (error) {
    return err(
      SorokitErrorCode.NETWORK_ERROR,
      `getInteractiveAssetInfo: ${error instanceof Error ? error.message : "Unknown error"}`,
      error,
    );
  }
}

/**
 * Initiate an interactive deposit flow with an anchor.
 *
 * @param serverUrl - The SEP-24 anchor server URL
 * @param request - Deposit request parameters
 * @param config - Optional flow configuration
 * @returns SorokitResult with deposit response containing URL
 */
export async function initiateInteractiveDeposit(
  serverUrl: string,
  request: InteractiveDepositRequest,
  config?: InteractiveFlowConfig,
): Promise<SorokitResult<InteractiveDepositResponse>> {
  try {
    if (!serverUrl || typeof serverUrl !== "string") {
      return err(
        SorokitErrorCode.VALIDATION,
        "initiateInteractiveDeposit: serverUrl must be a non-empty string.",
      );
    }

    if (!request.assetCode || !request.stellarAccount) {
      return err(
        SorokitErrorCode.VALIDATION,
        "initiateInteractiveDeposit: assetCode and stellarAccount are required.",
      );
    }

    const url = new URL("/sep24/deposit", serverUrl);
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...request,
        callback: config?.callback || request.callback,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return err(
        SorokitErrorCode.NETWORK_ERROR,
        `SEP-24 deposit request failed: ${response.status} ${response.statusText}`,
        errorText,
      );
    }

    const data = await response.json();
    const result = data as InteractiveDepositResponse;

    // Auto-open popup if configured and in browser environment
    if (config?.usePopup !== false && typeof window !== "undefined") {
      openInteractivePopup(result.url, config);
    }

    return ok(result);
  } catch (error) {
    return err(
      SorokitErrorCode.NETWORK_ERROR,
      `initiateInteractiveDeposit: ${error instanceof Error ? error.message : "Unknown error"}`,
      error,
    );
  }
}

/**
 * Initiate an interactive withdrawal flow with an anchor.
 *
 * @param serverUrl - The SEP-24 anchor server URL
 * @param request - Withdrawal request parameters
 * @param config - Optional flow configuration
 * @returns SorokitResult with withdrawal response containing URL
 */
export async function initiateInteractiveWithdraw(
  serverUrl: string,
  request: InteractiveWithdrawalRequest,
  config?: InteractiveFlowConfig,
): Promise<SorokitResult<InteractiveWithdrawalResponse>> {
  try {
    if (!serverUrl || typeof serverUrl !== "string") {
      return err(
        SorokitErrorCode.VALIDATION,
        "initiateInteractiveWithdraw: serverUrl must be a non-empty string.",
      );
    }

    if (!request.assetCode || !request.stellarAccount || !request.amount || !request.dest) {
      return err(
        SorokitErrorCode.VALIDATION,
        "initiateInteractiveWithdraw: assetCode, stellarAccount, amount, and dest are required.",
      );
    }

    const url = new URL("/sep24/withdraw", serverUrl);
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...request,
        callback: config?.callback || request.callback,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return err(
        SorokitErrorCode.NETWORK_ERROR,
        `SEP-24 withdrawal request failed: ${response.status} ${response.statusText}`,
        errorText,
      );
    }

    const data = await response.json();
    const result = data as InteractiveWithdrawalResponse;

    // Auto-open popup if configured and in browser environment
    if (config?.usePopup !== false && typeof window !== "undefined") {
      openInteractivePopup(result.url, config);
    }

    return ok(result);
  } catch (error) {
    return err(
      SorokitErrorCode.NETWORK_ERROR,
      `initiateInteractiveWithdraw: ${error instanceof Error ? error.message : "Unknown error"}`,
      error,
    );
  }
}

/**
 * Monitor the status of an interactive SEP-24 transaction.
 *
 * @param serverUrl - The SEP-24 anchor server URL
 * @param transactionId - The transaction ID to track
 * @param stellarAccount - The Stellar account associated with the transaction
 * @returns SorokitResult with transaction info
 */
export async function monitorTransaction(
  serverUrl: string,
  transactionId: string,
  stellarAccount: string,
): Promise<SorokitResult<InteractiveTransactionInfo>> {
  try {
    if (!serverUrl || typeof serverUrl !== "string") {
      return err(
        SorokitErrorCode.VALIDATION,
        "monitorTransaction: serverUrl must be a non-empty string.",
      );
    }

    if (!transactionId || typeof transactionId !== "string") {
      return err(
        SorokitErrorCode.VALIDATION,
        "monitorTransaction: transactionId must be a non-empty string.",
      );
    }

    if (!stellarAccount || typeof stellarAccount !== "string") {
      return err(
        SorokitErrorCode.VALIDATION,
        "monitorTransaction: stellarAccount must be a non-empty string.",
      );
    }

    const url = new URL("/sep24/transaction", serverUrl);
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
        `SEP-24 transaction status request failed: ${response.status} ${response.statusText}`,
        errorText,
      );
    }

    const data = await response.json();
    return ok(data as InteractiveTransactionInfo);
  } catch (error) {
    return err(
      SorokitErrorCode.NETWORK_ERROR,
      `monitorTransaction: ${error instanceof Error ? error.message : "Unknown error"}`,
      error,
    );
  }
}

/**
 * Get all transactions for a Stellar account from an anchor.
 *
 * @param serverUrl - The SEP-24 anchor server URL
 * @param stellarAccount - The Stellar account to query
 * @returns SorokitResult with array of transaction info
 */
export async function getInteractiveTransactions(
  serverUrl: string,
  stellarAccount: string,
): Promise<SorokitResult<InteractiveTransactionInfo[]>> {
  try {
    if (!serverUrl || typeof serverUrl !== "string") {
      return err(
        SorokitErrorCode.VALIDATION,
        "getInteractiveTransactions: serverUrl must be a non-empty string.",
      );
    }

    if (!stellarAccount || typeof stellarAccount !== "string") {
      return err(
        SorokitErrorCode.VALIDATION,
        "getInteractiveTransactions: stellarAccount must be a non-empty string.",
      );
    }

    const url = new URL("/sep24/transactions", serverUrl);
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
        `SEP-24 transactions request failed: ${response.status} ${response.statusText}`,
        errorText,
      );
    }

    const data = await response.json();
    const transactions = Array.isArray(data.transactions) ? data.transactions : [];
    return ok(transactions as InteractiveTransactionInfo[]);
  } catch (error) {
    return err(
      SorokitErrorCode.NETWORK_ERROR,
      `getInteractiveTransactions: ${error instanceof Error ? error.message : "Unknown error"}`,
      error,
    );
  }
}

/**
 * Open a popup window for the interactive flow.
 *
 * @param url - The URL to open
 * @param config - Optional popup configuration
 * @returns Window reference or null if not in browser environment
 */
export function openInteractivePopup(
  url: string,
  config?: InteractiveFlowConfig,
): Window | null {
  if (typeof window === "undefined") {
    return null;
  }

  const width = config?.popupWidth || 600;
  const height = config?.popupHeight || 700;
  const left = (window.screen.width - width) / 2;
  const top = (window.screen.height - height) / 2;

  const popup = window.open(
    url,
    "sorokit-sep24-flow",
    `width=${width},height=${height},left=${left},top=${top},resizable,scrollbars=yes`,
  );

  return popup;
}

/**
 * Poll a transaction status until completion or timeout.
 *
 * @param serverUrl - The SEP-24 anchor server URL
 * @param transactionId - The transaction ID to track
 * @param stellarAccount - The Stellar account associated with the transaction
 * @param options - Polling options
 * @returns SorokitResult with final transaction info
 */
export async function pollTransactionStatus(
  serverUrl: string,
  transactionId: string,
  stellarAccount: string,
  options?: {
    /** Maximum number of polling attempts (default: 20) */
    maxAttempts?: number;
    /** Interval between polls in milliseconds (default: 1500) */
    intervalMs?: number;
  },
): Promise<SorokitResult<InteractiveTransactionInfo>> {
  const maxAttempts = options?.maxAttempts || 20;
  const intervalMs = options?.intervalMs || 1500;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = await monitorTransaction(serverUrl, transactionId, stellarAccount);
    
    if (result.status === "error") {
      return result;
    }

    const status = result.data.status;
    
    // Return if transaction is in a terminal state
    if (
      status === "completed" ||
      status === "refunded" ||
      status === "no_market" ||
      status === "too_small" ||
      status === "too_large" ||
      status === "error"
    ) {
      return result;
    }

    // Wait before next poll
    if (attempt < maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  return err(
    SorokitErrorCode.OPERATION_TIMEOUT,
    `Transaction polling timed out after ${maxAttempts} attempts.`,
  );
}
