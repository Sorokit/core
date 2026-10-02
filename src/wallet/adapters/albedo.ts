/**
 * Albedo wallet adapter.
 *
 * Albedo (https://albedo.link) is a popular browser-based Stellar intent
 * wallet.  Unlike extension wallets, Albedo opens as a pop-up window — no
 * browser extension is required.  It works entirely in the browser via the
 * `@albedo-link/intent` JavaScript SDK.
 *
 * Consumer responsibilities:
 * - Install @albedo-link/intent (peer dependency)
 *   npm install @albedo-link/intent
 *
 * Usage example:
 * ```ts
 * import { AlbedoAdapter } from "sorokit-core/wallet";
 *
 * const adapter = new AlbedoAdapter();
 * await adapter.connect();          // opens Albedo pop-up
 * await adapter.signTransaction({ transactionXdr, networkPassphrase });
 * ```
 *
 * The adapter lazily imports `@albedo-link/intent` so it is never bundled
 * unless this adapter is actually used — consistent with the WalletConnect
 * adapter approach.
 */

import { WalletType } from "../types";
import type { WalletAdapter, SignTransactionInput } from "../types";
import { ok, err, SorokitErrorCode } from "../../shared/response";
import type { SorokitResult } from "../../shared/response";
import { isBrowser, isUserRejection, isTimeoutError, toMessage } from "../../shared";

// ─── Albedo SDK types (typed locally — never imported at runtime until the
//     consumer installs @albedo-link/intent) ──────────────────────────────────

interface AlbedoPublicKeyResult {
  pubkey: string;
  /** Albedo session token — not used by sorokit but returned by the SDK. */
  session?: string;
}

interface AlbedoSignResult {
  /** Signed transaction XDR returned by Albedo. */
  signed_envelope_xdr: string;
  /** Transaction hash (hex). */
  tx_hash: string;
}

interface AlbedoIntent {
  /**
   * Request the user's public key.
   * Opens the Albedo pop-up if no session token is present.
   */
  publicKey(opts?: { require_existing?: boolean }): Promise<AlbedoPublicKeyResult>;

  /**
   * Request the user to sign a transaction XDR.
   * Opens the Albedo signing pop-up.
   */
  tx(opts: {
    xdr: string;
    network: "public" | "testnet";
    /** Optional: description shown to the user inside the Albedo pop-up. */
    description?: string;
  }): Promise<AlbedoSignResult>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Map a Stellar network passphrase to the Albedo network identifier.
 * Albedo accepts "public" or "testnet"; anything else is treated as testnet
 * (custom / private networks), and the user's wallet will ultimately validate
 * the passphrase embedded in the XDR.
 */
function albedoNetwork(passphrase: string): "public" | "testnet" {
  const p = passphrase.trim();
  if (p === "Public Global Stellar Network ; September 2015") return "public";
  return "testnet";
}

/** Dynamic import of @albedo-link/intent — true peer dependency. */
async function loadAlbedo(): Promise<AlbedoIntent> {
  try {
    const mod = await import("@albedo-link/intent" as string);
    const albedo = (mod.default ?? mod) as AlbedoIntent;
    if (typeof albedo?.publicKey !== "function" || typeof albedo?.tx !== "function") {
      throw new Error("Unexpected @albedo-link/intent module shape.");
    }
    return albedo;
  } catch (cause) {
    throw new Error(
      `Albedo requires @albedo-link/intent. ` +
        `Install it: npm install @albedo-link/intent\n` +
        `Original error: ${toMessage(cause)}`,
    );
  }
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

export class AlbedoAdapter implements WalletAdapter {
  readonly walletType = WalletType.ALBEDO;

  /** Public key resolved on the last successful connect(). */
  private _publicKey: string | null = null;

  // ─── WalletAdapter ──────────────────────────────────────────────────────────

  /**
   * Albedo is browser-only — it opens a pop-up window and communicates via
   * postMessage.  Returns false in Node and non-browser environments.
   */
  isAvailable(): boolean {
    return isBrowser();
  }

  /**
   * Open the Albedo pop-up to obtain the user's public key.
   * Returns the public key string on success.
   */
  async connect(): Promise<SorokitResult<string>> {
    if (!this.isAvailable()) {
      return err(
        SorokitErrorCode.WALLET_BROWSER_ONLY,
        "Albedo requires a browser environment.",
      );
    }

    let albedo: AlbedoIntent;
    try {
      albedo = await loadAlbedo();
    } catch (cause) {
      return err(
        SorokitErrorCode.WALLET_NOT_FOUND,
        toMessage(cause),
        cause,
      );
    }

    try {
      const { pubkey } = await albedo.publicKey();
      if (!pubkey) {
        return err(
          SorokitErrorCode.WALLET_CONNECT_FAILED,
          "Albedo returned an empty public key.",
        );
      }
      this._publicKey = pubkey;
      return ok(pubkey);
    } catch (cause) {
      if (isUserRejection(cause)) {
        return err(
          SorokitErrorCode.WALLET_SIGN_REJECTED,
          "User rejected the Albedo connection request.",
          cause,
        );
      }
      if (isTimeoutError(cause)) {
        return err(
          SorokitErrorCode.OPERATION_TIMEOUT,
          `Albedo connection timed out: ${toMessage(cause)}`,
          cause,
        );
      }
      return err(
        SorokitErrorCode.WALLET_CONNECT_FAILED,
        `Albedo connection failed: ${toMessage(cause)}`,
        cause,
      );
    }
  }

  /**
   * Albedo is a stateless intent wallet — there is no persistent session to
   * terminate.  Clears the locally-cached public key and returns success.
   */
  async disconnect(): Promise<SorokitResult<undefined>> {
    this._publicKey = null;
    return ok(undefined);
  }

  /**
   * Open the Albedo signing pop-up for the given transaction XDR.
   * Returns the signed XDR string on success.
   */
  async signTransaction(
    input: SignTransactionInput,
  ): Promise<SorokitResult<string>> {
    if (!this.isAvailable()) {
      return err(
        SorokitErrorCode.WALLET_BROWSER_ONLY,
        "Albedo requires a browser environment.",
      );
    }

    let albedo: AlbedoIntent;
    try {
      albedo = await loadAlbedo();
    } catch (cause) {
      return err(
        SorokitErrorCode.WALLET_NOT_FOUND,
        toMessage(cause),
        cause,
      );
    }

    try {
      const network = albedoNetwork(input.networkPassphrase);
      const { signed_envelope_xdr } = await albedo.tx({
        xdr: input.transactionXdr,
        network,
      });

      if (!signed_envelope_xdr) {
        return err(
          SorokitErrorCode.WALLET_SIGN_FAILED,
          "Albedo returned an empty signed transaction XDR.",
        );
      }

      return ok(signed_envelope_xdr);
    } catch (cause) {
      if (isUserRejection(cause)) {
        return err(
          SorokitErrorCode.WALLET_SIGN_REJECTED,
          "User rejected the Albedo signature request.",
          cause,
        );
      }
      if (isTimeoutError(cause)) {
        return err(
          SorokitErrorCode.OPERATION_TIMEOUT,
          `Albedo signing timed out: ${toMessage(cause)}`,
          cause,
        );
      }
      return err(
        SorokitErrorCode.WALLET_SIGN_FAILED,
        `Albedo signing failed: ${toMessage(cause)}`,
        cause,
      );
    }
  }
}
