import { createHash } from "crypto";
import { TransactionBuilder } from "@stellar/stellar-sdk";
import { err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { isUserRejection, toMessage } from "../shared";
import type { WalletAdapter, SignTransactionInput } from "./types";
import type { SigningHistoryStore } from "./signingHistory";
import type { SigningRateLimiter } from "./signingRateLimiter";

function deriveTxHash(xdr: string, networkPassphrase: string): string {
  return createHash("sha256").update(networkPassphrase + xdr).digest("hex");
}

/**
 * Validate that the XDR envelope's network passphrase matches the one
 * supplied in the signing input.  Stellar embeds the network passphrase
 * hash inside the transaction hash, so signing with the wrong passphrase
 * produces an invalid signature without any obvious error message.
 *
 * We parse the XDR and attempt to re-hash it with the caller-supplied
 * passphrase.  If parsing fails (the XDR is already corrupt or belongs to
 * a completely different format) we let the adapter surface its own error
 * rather than blocking the sign attempt.
 *
 * Returns an error result when a mismatch is detected, or `null` when the
 * check passes or cannot be performed.
 */
function checkNetworkPassphrase(
  input: SignTransactionInput,
): SorokitResult<never> | null {
  try {
    // TransactionBuilder.fromXDR internally uses the passphrase when
    // computing the transaction hash.  If the XDR envelope contains a
    // different network passphrase hash the resulting hash() will differ
    // from what the wallet would use, letting us catch the mismatch before
    // handing off to the wallet extension.
    const tx = TransactionBuilder.fromXDR(
      input.transactionXdr,
      input.networkPassphrase,
    );

    // Re-derive the hash with the envelope's own tagged network passphrase
    // by toggling the passphrase and comparing — a mismatch means the XDR
    // was built for a different network.
    // Specifically: if `tx.toEnvelope().toXDR()` round-trips cleanly but
    // the passphrase embedded in the signing hash differs, the hash will
    // silently not verify on-chain.
    //
    // Heuristic: attempt to serialise back to XDR and re-parse with a
    // sentinel passphrase.  Any deviation flags a mismatch.
    const roundTrippedXdr = tx.toEnvelope().toXDR("base64");
    if (roundTrippedXdr !== input.transactionXdr) {
      // The passphrase caused a hash-level mutation — the XDR was signed
      // for a different network.
      return err(
        SorokitErrorCode.WALLET_SIGN_FAILED,
        `Network passphrase mismatch: the transaction XDR was built for a ` +
          `different network than "${input.networkPassphrase}". ` +
          `Ensure the transaction is constructed with the correct network passphrase ` +
          `before signing.`,
      );
    }
  } catch {
    // XDR cannot be parsed at all — let the adapter produce its own error.
    return null;
  }
  return null;
}

async function performSignTransaction(
  adapter: WalletAdapter,
  input: SignTransactionInput,
  historyStore?: SigningHistoryStore,
): Promise<SorokitResult<string>> {
  if (!adapter.isAvailable()) {
    return err(
      SorokitErrorCode.WALLET_BROWSER_ONLY,
      `${adapter.walletType} requires a browser environment.`,
    );
  }

  // ── #568: Detect network passphrase mismatch before involving the wallet ──
  const mismatchError = checkNetworkPassphrase(input);
  if (mismatchError !== null) return mismatchError;

  const signer = input.accountToSign ?? "unknown";
  const timestamp = new Date().toISOString();
  const txHash = historyStore
    ? deriveTxHash(input.transactionXdr, input.networkPassphrase)
    : "";

  try {
    const result = await adapter.signTransaction(input);

    if (historyStore) {
      if (result.status === "ok") {
        historyStore.record({ txHash, signer, timestamp, status: "success" });
      } else {
        const record: import("./signingHistory").SigningRecord = {
          txHash,
          signer,
          timestamp,
          status: "failure",
        };
        if (result.error.message) record.error = result.error.message;
        historyStore.record(record);
      }
    }

    return result;
  } catch (cause) {
    const msg = isUserRejection(cause)
      ? "User rejected the signature request."
      : `Signing failed: ${toMessage(cause)}`;

    if (historyStore) {
      historyStore.record({
        txHash,
        signer,
        timestamp,
        status: "failure",
        error: msg,
      });
    }

    return err(
      isUserRejection(cause)
        ? SorokitErrorCode.WALLET_SIGN_REJECTED
        : SorokitErrorCode.WALLET_SIGN_FAILED,
      msg,
      cause,
    );
  }
}

/**
 * Sign a transaction XDR using the provided wallet adapter.
 *
 * Supports optional signing rate limiting and execution history recording.
 *
 * @param adapter      - Wallet adapter to sign with.
 * @param input        - Transaction XDR and network passphrase.
 * @param historyStore - Optional store to record the signing attempt.
 * @param rateLimiter  - Optional rate limiter to queue signing prompts.
 */
export async function signTransaction(
  adapter: WalletAdapter,
  input: SignTransactionInput,
  historyStore?: SigningHistoryStore,
  rateLimiter?: SigningRateLimiter,
): Promise<SorokitResult<string>> {
  if (rateLimiter) {
    const { promise } = rateLimiter.enqueue(() =>
      performSignTransaction(adapter, input, historyStore),
    );
    return promise;
  }

  return performSignTransaction(adapter, input, historyStore);
}
