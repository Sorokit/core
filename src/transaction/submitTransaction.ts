import { Horizon, TransactionBuilder, Keypair, FeeBumpTransaction, StrKey } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import {
  checkMainnetSafety,
  isNetworkConnectivityError,
  isTimeoutError,
  isXdrInvalidError,
  retryWithBackoff,
  toMessage,
} from "../shared";
import type { MainnetSafetyOptions, SorokitLogger } from "../shared";
import type { TransactionResult } from "./types";
import { dispatchTransactionEvent } from "./webhooks";
import type { SorokitCache } from "../shared/cache";
import { DEFAULT_TX_CACHE_TTL_MS } from "../shared/constants";
import { createHorizonServer, createSorobanServer } from "../shared/serverFactory";
import { CircuitBreakerRegistry } from "../network/circuitBreaker";
import { mapHorizonError } from "../shared/horizonErrorMapper";

// Shared circuit breaker registry for Horizon operations
const horizonCircuitBreaker = new CircuitBreakerRegistry({
  failureThreshold: 5,
  recoveryWindowMs: 30_000,
});

// ── #569: XDR Replay Protection ───────────────────────────────────────────────
//
// In-process registry of successfully-submitted transaction hashes.
// Keyed by "<horizonUrl>|<txHash>" so separate networks are independent.
// Entries are stored with their submission timestamp so callers can detect
// how long ago the duplicate was submitted.
//
// This covers the most dangerous case: the same signed XDR being re-submitted
// within the same process lifetime (e.g. a double-click, a retry loop that
// fires before the previous call resolves, or a copied XDR being reused).
// Cross-process and cross-session protection is enforced by Horizon's
// sequence-number ledger rules — this layer is a fast client-side guard.

interface ReplayRecord {
  submittedAt: number;   // Unix ms
  hash: string;
}

const _submittedHashes = new Map<string, ReplayRecord>();

/** Key used to namespace replay entries per Horizon endpoint. */
function replayKey(horizonUrl: string, txHash: string): string {
  return `${horizonUrl}|${txHash}`;
}

/**
 * Register a transaction hash as successfully submitted.
 * Automatically prunes entries older than `ttlMs` on every write to keep
 * memory bounded. Defaults to 5 minutes, which is well past Stellar's
 * transaction timeout window.
 */
function registerSubmitted(horizonUrl: string, txHash: string, ttlMs = 300_000): void {
  const now = Date.now();
  // Prune stale entries before inserting
  for (const [key, record] of _submittedHashes) {
    if (now - record.submittedAt > ttlMs) _submittedHashes.delete(key);
  }
  _submittedHashes.set(replayKey(horizonUrl, txHash), { submittedAt: now, hash: txHash });
}

/**
 * Returns the replay record for a previously-submitted hash, or undefined
 * when no match is found (or the entry has expired).
 */
function getReplayRecord(horizonUrl: string, txHash: string, ttlMs = 300_000): ReplayRecord | undefined {
  const record = _submittedHashes.get(replayKey(horizonUrl, txHash));
  if (!record) return undefined;
  if (Date.now() - record.submittedAt > ttlMs) {
    _submittedHashes.delete(replayKey(horizonUrl, txHash));
    return undefined;
  }
  return record;
}

function describeSubmissionFailure(cause: unknown): string {
  if (isXdrInvalidError(cause)) {
    return `Transaction submission failed because the signed XDR is malformed: ${toMessage(cause)}`;
  }
  if (isTimeoutError(cause)) {
    return `Transaction submission timed out while contacting Horizon: ${toMessage(cause)}`;
  }
  if (isNetworkConnectivityError(cause)) {
    return `Transaction submission failed due to network connectivity: ${toMessage(cause)}`;
  }
  return `Transaction submission failed: ${toMessage(cause)}`;
}

/**
 * Verify that signatures in the parsed transaction were made for the given
 * networkPassphrase by checking the source account's signature hint.
 * Returns true when a mismatch is detected (signatures don't verify for this network).
 * Returns false when the check passes or cannot be performed (falls back to Horizon).
 */
function detectNetworkPassphraseMismatch(
  tx: ReturnType<typeof TransactionBuilder.fromXDR>,
  networkPassphrase: string,
): boolean {
  const source = tx instanceof FeeBumpTransaction ? tx.feeSource : tx.source;

  if (!source) return false;

  // Extract the inner G-address from muxed accounts (M...)
  let sourceAccountId = source;
  if (source.startsWith("M")) {
    try {
      sourceAccountId = StrKey.encodeEd25519PublicKey(
        StrKey.decodeMed25519PublicKey(source).subarray(0, 32),
      );
    } catch {
      // If muxed account decoding fails, fall back to Horizon validation
      return false;
    }
  }

  try {
    const keypair = Keypair.fromPublicKey(sourceAccountId);
    const expectedHash = tx.hash();
    const hint = keypair.rawPublicKey().slice(-4);

    for (const decoratedSig of tx.signatures) {
      if (!decoratedSig.hint().equals(hint)) continue;
      // This signature claims to be from the source account.
      // If it doesn't verify for the given network, the transaction was signed for a different network.
      try {
        if (!keypair.verify(expectedHash, decoratedSig.signature())) return true;
      } catch {
        return true;
      }
    }
  } catch {
    // If key parsing or verification fails in an unexpected way, fall through.
  }

  return false;
}

/**
 * Submit a signed transaction XDR to the Stellar network via Horizon.
 *
 * Validates the network passphrase before submission so that testnet/mainnet
 * mismatches are caught client-side rather than with an unhelpful Horizon error.
 * Retries on transient network failures with exponential back-off.
 * When a `cache` is provided, a successful result is stored keyed by the
 * transaction hash to allow fast idempotent re-checks via `getTransactionStatus`.
 *
 * @param horizonUrl        - Base URL of the Horizon server.
 * @param networkPassphrase - Network passphrase used to sign the transaction.
 * @param signedXdr         - Signed transaction XDR produced by `signTransaction`.
 * @param cache             - Optional cache for deduplication and status look-ups.
 * @returns `ok(TransactionResult)` on success, or `error(TX_SUBMIT_FAILED)` on failure.
 *
 * @example
 * const result = await submitTransaction(horizonUrl, networkPassphrase, signedXdr);
 * if (result.status === "ok") {
 *   console.log("Confirmed in ledger", result.data.ledger);
 * }
 */
export async function submitTransaction(
  horizonUrl: string,
  networkPassphrase: string,
  signedXdr: string,
  cache?: SorokitCache,
  options?: MainnetSafetyOptions & { signal?: AbortSignal | undefined },
): Promise<SorokitResult<TransactionResult>> {
  if (isXdrInvalidError(signedXdr)) {
    return err(
      SorokitErrorCode.TX_SUBMIT_FAILED,
      "Transaction submission failed because the signed XDR is malformed.",
      signedXdr,
    );
  }

  const safetyCheck = checkMainnetSafety(signedXdr, networkPassphrase, options);
  if (safetyCheck.status === "error") {
    return safetyCheck;
  }

  let txHash: string | undefined;

  try {
    const tx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
    try {
      // Only needed to label webhook events on failure paths; never let hash
      // computation itself fail a submission.
      txHash = tx.hash().toString("hex");
    } catch {
      txHash = undefined;
    }

    if (detectNetworkPassphraseMismatch(tx, networkPassphrase)) {
      const isMuxed = (tx instanceof FeeBumpTransaction ? tx.feeSource : tx.source)?.startsWith("M");
      const message = isMuxed
        ? `Network passphrase mismatch: the muxed account transaction was signed for a different network. Expected: "${networkPassphrase}".`
        : `Network passphrase mismatch: the transaction was signed for a different network. Expected: "${networkPassphrase}".`;
      return err(
        SorokitErrorCode.TX_SUBMIT_FAILED,
        message,
      );
    }

    // ── #569: XDR Replay Protection ───────────────────────────────────────────
    // Reject duplicate XDR submissions within the same process lifetime.
    // This guards against double-clicks, retry loops, and copied XDRs being
    // reused — catastrophic for payment operations.
    if (txHash) {
      const duplicate = getReplayRecord(horizonUrl, txHash);
      if (duplicate) {
        const ageSeconds = Math.round((Date.now() - duplicate.submittedAt) / 1000);
        return err(
          SorokitErrorCode.TX_SUBMIT_FAILED,
          `Replay protection: this transaction (hash: ${txHash}) was already ` +
            `submitted to this network ${ageSeconds}s ago. ` +
            `Resubmitting the same signed XDR would create a duplicate transaction. ` +
            `Build and sign a new transaction if you want to retry the operation.`,
        );
      }
    }

    const response = await horizonCircuitBreaker.call(horizonUrl, async () => {
      return await retryWithBackoff(async () => {
        const server = createHorizonServer(horizonUrl, options);
        return await server.submitTransaction(tx);
      });
    });

    const result: TransactionResult = {
      hash: response.hash,
      status: "success",
      ledger: response.ledger,
      envelopeXdr: response.envelope_xdr,
      resultXdr: response.result_xdr,
    };

    if (cache) {
      cache.set(`tx:${response.hash}`, result, DEFAULT_TX_CACHE_TTL_MS);
    }

    // Register in the replay-protection registry so the same XDR cannot be
    // submitted again within the TTL window.
    registerSubmitted(horizonUrl, response.hash);

    // Horizon's synchronous submit returns after ledger inclusion, so a
    // success is both "submitted" and "confirmed". Fire-and-forget: webhook
    // delivery never blocks or fails the submission result.
    dispatchTransactionEvent("tx_submitted", result);
    dispatchTransactionEvent("tx_confirmed", result);

    return ok(result);
  } catch (cause) {
    const mapped = mapHorizonError(cause, {
      resource: "transaction",
      fallbackCode: SorokitErrorCode.TX_SUBMIT_FAILED,
    });
    if (txHash) {
      // A Horizon timeout leaves the transaction outcome unknown (it may
      // still make it into a ledger), so it is reported as pending timeout
      // rather than failed.
      const timedOut = isTimeoutError(cause);
      dispatchTransactionEvent(timedOut ? "tx_timeout" : "tx_failed", {
        hash: txHash,
        status: timedOut ? "pending" : "failed",
      });
    }
    return err(
      mapped.code,
      mapped.code === SorokitErrorCode.TX_SUBMIT_FAILED
        ? describeSubmissionFailure(cause)
        : mapped.message,
      cause,
      undefined,
      mapped.recovery ? { recovery: mapped.recovery } : undefined,
    );
  }
}
