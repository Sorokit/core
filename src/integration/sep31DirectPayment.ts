/**
 * SEP-31 Direct Payments - Cross-border payment integration
 *
 * Implements sender-side integration for SEP-31 cross-border payments between
 * anchors and receivers. Handles quote fetching, payment initiation, and
 * transaction tracking.
 */

import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { Asset } from "@stellar/stellar-sdk";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface DirectPaymentQuoteRequest {
  /** Source asset code */
  sourceAsset: string;
  /** Source asset issuer (optional for native) */
  sourceAssetIssuer?: string;
  /** Destination asset code */
  destinationAsset: string;
  /** Destination asset issuer (optional for native) */
  destinationAssetIssuer?: string;
  /** Amount to send (in source asset) */
  amount: string;
  /** Receiver's account public key or SEP-31 receiving account ID */
  receiver: string;
  /** Destination memo (optional) */
  destinationMemo?: string;
  /** Destination memo type (optional) */
  destinationMemoType?: "text" | "id" | "hash" | "return";
}

export interface DirectPaymentQuoteResponse {
  /** Quote ID for later payment initiation */
  id: string;
  /** Amount to send in source asset */
  amountIn: string;
  /** Amount to receive in destination asset */
  amountOut: string;
  /** Fee charged by the anchor */
  fee: {
    total: string;
    sourceAsset: string;
    sourceAssetIssuer?: string;
  };
  /** When the quote expires (ISO 8601 timestamp) */
  expiresAt: string;
  /** Expected delivery time (ISO 8601 timestamp) */
  estimatedDeliveryAt?: string;
}

export interface DirectPaymentRequest {
  /** Quote ID from quote response */
  quoteId: string;
  /** Sender's Stellar public key */
  sender: string;
  /** Optional memo for the payment */
  memo?: string;
  /** Optional memo type */
  memoType?: "text" | "id" | "hash" | "return";
}

export interface DirectPaymentResponse {
  /** Payment ID for tracking */
  id: string;
  /** Stellar transaction ID (once submitted) */
  stellarTransactionId?: string;
  /** Payment status */
  status: "pending" | "completed" | "failed";
  /** Amount sent */
  amountIn: string;
  /** Amount received */
  amountOut: string;
  /** Fee charged */
  fee: string;
  /** Timestamp of payment initiation */
  createdAt: string;
  /** When payment was completed (if applicable) */
  completedAt?: string;
  /** Error message if payment failed */
  error?: string;
}

export interface DirectPaymentStatusResponse {
  /** Payment ID */
  id: string;
  /** Stellar transaction ID */
  stellarTransactionId?: string;
  /** Current payment status */
  status: "pending" | "pending_stellar" | "pending_external" | "completed" | "failed";
  /** Amount sent */
  amountIn: string;
  /** Amount received */
  amountOut: string;
  /** Fee charged */
  fee: string;
  /** Timestamp of payment initiation */
  createdAt: string;
  /** When payment was completed (if applicable) */
  completedAt?: string;
  /** Error message if payment failed */
  error?: string;
  /** Additional status information */
  statusMessage?: string;
}

// ─── Implementation ───────────────────────────────────────────────────────────

/**
 * Fetch a quote for a direct cross-border payment.
 *
 * @param serverUrl - The SEP-31 anchor server URL
 * @param request - Quote request parameters
 * @returns SorokitResult with quote response
 */
export async function quoteDirectPayment(
  serverUrl: string,
  request: DirectPaymentQuoteRequest,
): Promise<SorokitResult<DirectPaymentQuoteResponse>> {
  try {
    if (!serverUrl || typeof serverUrl !== "string") {
      return err(
        SorokitErrorCode.VALIDATION,
        "quoteDirectPayment: serverUrl must be a non-empty string.",
      );
    }

    if (!request.sourceAsset || !request.destinationAsset || !request.amount || !request.receiver) {
      return err(
        SorokitErrorCode.VALIDATION,
        "quoteDirectPayment: sourceAsset, destinationAsset, amount, and receiver are required.",
      );
    }

    const url = new URL("/sep31/quotes", serverUrl);
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
        `SEP-31 quote request failed: ${response.status} ${response.statusText}`,
        errorText,
      );
    }

    const data = await response.json();
    return ok(data as DirectPaymentQuoteResponse);
  } catch (error) {
    return err(
      SorokitErrorCode.NETWORK_ERROR,
      `quoteDirectPayment: ${error instanceof Error ? error.message : "Unknown error"}`,
      error,
    );
  }
}

/**
 * Initiate a direct cross-border payment using a previously obtained quote.
 *
 * @param serverUrl - The SEP-31 anchor server URL
 * @param request - Payment request parameters
 * @returns SorokitResult with payment response
 */
export async function sendDirectPayment(
  serverUrl: string,
  request: DirectPaymentRequest,
): Promise<SorokitResult<DirectPaymentResponse>> {
  try {
    if (!serverUrl || typeof serverUrl !== "string") {
      return err(
        SorokitErrorCode.VALIDATION,
        "sendDirectPayment: serverUrl must be a non-empty string.",
      );
    }

    if (!request.quoteId || !request.sender) {
      return err(
        SorokitErrorCode.VALIDATION,
        "sendDirectPayment: quoteId and sender are required.",
      );
    }

    const url = new URL("/sep31/transactions", serverUrl);
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
        `SEP-31 payment request failed: ${response.status} ${response.statusText}`,
        errorText,
      );
    }

    const data = await response.json();
    return ok(data as DirectPaymentResponse);
  } catch (error) {
    return err(
      SorokitErrorCode.NETWORK_ERROR,
      `sendDirectPayment: ${error instanceof Error ? error.message : "Unknown error"}`,
      error,
    );
  }
}

/**
 * Track the status of a direct cross-border payment.
 *
 * @param serverUrl - The SEP-31 anchor server URL
 * @param paymentId - The payment ID to track
 * @returns SorokitResult with payment status
 */
export async function trackDirectPayment(
  serverUrl: string,
  paymentId: string,
): Promise<SorokitResult<DirectPaymentStatusResponse>> {
  try {
    if (!serverUrl || typeof serverUrl !== "string") {
      return err(
        SorokitErrorCode.VALIDATION,
        "trackDirectPayment: serverUrl must be a non-empty string.",
      );
    }

    if (!paymentId || typeof paymentId !== "string") {
      return err(
        SorokitErrorCode.VALIDATION,
        "trackDirectPayment: paymentId must be a non-empty string.",
      );
    }

    const url = new URL(`/sep31/transactions/${paymentId}`, serverUrl);
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
        `SEP-31 status request failed: ${response.status} ${response.statusText}`,
        errorText,
      );
    }

    const data = await response.json();
    return ok(data as DirectPaymentStatusResponse);
  } catch (error) {
    return err(
      SorokitErrorCode.NETWORK_ERROR,
      `trackDirectPayment: ${error instanceof Error ? error.message : "Unknown error"}`,
      error,
    );
  }
}

/**
 * Validate a receiver's information for SEP-31 payments.
 *
 * @param serverUrl - The SEP-31 anchor server URL
 * @param receiver - The receiver's account public key or SEP-31 receiving account ID
 * @returns SorokitResult with validation information
 */
export async function validateReceiver(
  serverUrl: string,
  receiver: string,
): Promise<SorokitResult<{ valid: boolean; account?: string; message?: string }>> {
  try {
    if (!serverUrl || typeof serverUrl !== "string") {
      return err(
        SorokitErrorCode.VALIDATION,
        "validateReceiver: serverUrl must be a non-empty string.",
      );
    }

    if (!receiver || typeof receiver !== "string") {
      return err(
        SorokitErrorCode.VALIDATION,
        "validateReceiver: receiver must be a non-empty string.",
      );
    }

    const url = new URL("/sep31/receiver", serverUrl);
    url.searchParams.append("id", receiver);
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
        `SEP-31 receiver validation failed: ${response.status} ${response.statusText}`,
        errorText,
      );
    }

    const data = await response.json();
    return ok(data as { valid: boolean; account?: string; message?: string });
  } catch (error) {
    return err(
      SorokitErrorCode.NETWORK_ERROR,
      `validateReceiver: ${error instanceof Error ? error.message : "Unknown error"}`,
      error,
    );
  }
}
