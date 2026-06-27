import { createHash } from "crypto";
import { err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { isUserRejection, toMessage } from "../shared";
import type { WalletAdapter, SignTransactionInput } from "./types";
import type { SigningHistoryStore } from "./signingHistory";

function deriveTxHash(xdr: string, networkPassphrase: string): string {
  return createHash("sha256").update(networkPassphrase + xdr).digest("hex");
}

/**
 * Sign a transaction XDR using the provided wallet adapter.
 *
 * The adapter handles wallet-specific signing logic and user rejection detection.
 * This function only enforces the browser guard before delegating.
 *
 * When `historyStore` is provided every signing attempt — success or failure —
 * is recorded with the transaction hash, signer address, ISO-8601 timestamp,
 * and outcome. History tracking is fully opt-in; omitting the parameter leaves
 * existing behaviour unchanged.
 *
 * @param adapter - Wallet adapter to sign with.
 * @param input - Transaction XDR and network passphrase.
 * @param historyStore - Optional store to record the signing attempt.
 */
export async function signTransaction(
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
      historyStore.record({ txHash, signer, timestamp, status: "failure", error: msg });
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
