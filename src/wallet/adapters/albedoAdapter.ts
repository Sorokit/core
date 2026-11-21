/**
 * Albedo Web Wallet Session & Direct/WalletConnect Integration (#923)
 *
 * Provides `connectAlbedo()` and `AlbedoSession` with `getAccount()`,
 * `signTransaction(xdr)`, and `signMessage(message)` returning `SorokitResult<T>`.
 */

import { ok, err, SorokitErrorCode } from "../../shared/response";
import type { SorokitResult } from "../../shared/response";
import { isUserRejection, isTimeoutError, toMessage } from "../../shared";
import { validatePublicKey } from "../../shared/validation";

/** Minimal contract for the Albedo web intent API (`@albedo-link/intent`). */
export interface AlbedoIntentProvider {
  publicKey(opts?: {
    require_existing?: boolean;
    token?: string;
  }): Promise<{
    pubkey: string;
    signed_message?: string;
    signature?: string;
    session?: string;
  }>;

  tx(opts: {
    xdr: string;
    network: "public" | "testnet";
    pubkey?: string;
    description?: string;
    submit?: boolean;
  }): Promise<{
    signed_envelope_xdr: string;
    tx_hash?: string;
    network?: string;
  }>;

  signMessage?(opts: {
    message: string;
    pubkey?: string;
  }): Promise<{
    message: string;
    pubkey: string;
    message_signature: string;
  }>;
}

export interface AlbedoConnectOptions {
  /** Default network for transaction signing ("public" | "testnet" or Stellar network passphrase). Default: "testnet". */
  network?: string;
  /** Require an existing Albedo session when requesting public key. */
  requireExisting?: boolean;
  /** Optional custom Albedo provider instance or loader function. */
  provider?: AlbedoIntentProvider | (() => Promise<AlbedoIntentProvider>);
}

export interface AlbedoSignedTx {
  signedXdr: string;
  txHash?: string;
  network: "public" | "testnet";
  signerPublicKey: string;
}

export interface AlbedoSignedMessage {
  message: string;
  publicKey: string;
  messageSignature: string;
}

function resolveAlbedoNetwork(networkOrPassphrase?: string): "public" | "testnet" {
  if (!networkOrPassphrase) return "testnet";
  const normalized = networkOrPassphrase.trim().toLowerCase();
  if (
    normalized === "public" ||
    normalized === "mainnet" ||
    networkOrPassphrase.trim() === "Public Global Stellar Network ; September 2015"
  ) {
    return "public";
  }
  return "testnet";
}

async function resolveAlbedoProvider(
  providerOption?: AlbedoIntentProvider | (() => Promise<AlbedoIntentProvider>),
): Promise<AlbedoIntentProvider> {
  if (typeof providerOption === "function") {
    return await providerOption();
  }
  if (providerOption && typeof providerOption === "object") {
    return providerOption;
  }

  const mod = await import("@albedo-link/intent" as string);
  const albedo = (mod.default ?? mod) as AlbedoIntentProvider;
  if (
    typeof albedo?.publicKey !== "function" ||
    typeof albedo?.tx !== "function"
  ) {
    throw new Error("Invalid @albedo-link/intent module shape.");
  }
  return albedo;
}

function classifyAlbedoError(
  operation: "connection" | "account lookup" | "transaction signing" | "message signing",
  cause: unknown,
  fallbackCode: SorokitErrorCode,
): SorokitResult<never> {
  if (isUserRejection(cause)) {
    return err(
      SorokitErrorCode.WALLET_SIGN_REJECTED,
      `User rejected the Albedo ${operation} request.`,
      cause,
    );
  }
  if (isTimeoutError(cause)) {
    return err(
      SorokitErrorCode.OPERATION_TIMEOUT,
      `Albedo ${operation} timed out: ${toMessage(cause)}`,
      cause,
    );
  }
  return err(
    fallbackCode,
    `Albedo ${operation} failed: ${toMessage(cause)}`,
    cause,
  );
}

/**
 * Active Albedo web wallet session returned by {@link connectAlbedo} (#923).
 */
export class AlbedoSession {
  readonly providerName = "ALBEDO" as const;
  private currentPublicKey: string;
  private readonly defaultNetwork: "public" | "testnet";

  constructor(
    private readonly provider: AlbedoIntentProvider,
    initialPublicKey: string,
    network?: string,
  ) {
    this.currentPublicKey = initialPublicKey;
    this.defaultNetwork = resolveAlbedoNetwork(network);
  }

  /**
   * Return the connected Albedo account's Stellar public key, or refresh it
   * from the provider if `refresh` is true.
   */
  async getAccount(refresh = false): Promise<SorokitResult<string>> {
    if (!refresh && this.currentPublicKey) {
      return ok(this.currentPublicKey);
    }

    try {
      const response = await this.provider.publicKey();
      const pubkey = response?.pubkey?.trim() ?? "";
      const valid = validatePublicKey(pubkey);
      if (valid.status === "error") {
        return err(
          SorokitErrorCode.WALLET_CONNECT_FAILED,
          `Albedo returned an invalid public key: ${valid.error.message}`,
        );
      }
      this.currentPublicKey = pubkey;
      return ok(pubkey);
    } catch (cause) {
      return classifyAlbedoError(
        "account lookup",
        cause,
        SorokitErrorCode.WALLET_CONNECT_FAILED,
      );
    }
  }

  /**
   * Sign a transaction XDR using Albedo and return `SorokitResult<AlbedoSignedTx>`.
   */
  async signTransaction(
    xdr: string,
    options?: { network?: string; description?: string },
  ): Promise<SorokitResult<AlbedoSignedTx>> {
    if (typeof xdr !== "string" || xdr.trim().length === 0) {
      return err(
        SorokitErrorCode.XDR_INVALID,
        "signTransaction requires a non-empty transaction XDR string.",
      );
    }

    const network = options?.network
      ? resolveAlbedoNetwork(options.network)
      : this.defaultNetwork;

    try {
      const result = await this.provider.tx({
        xdr: xdr.trim(),
        network,
        pubkey: this.currentPublicKey,
        ...(options?.description ? { description: options.description } : {}),
      });

      const signedXdr = result?.signed_envelope_xdr?.trim() ?? "";
      if (!signedXdr) {
        return err(
          SorokitErrorCode.WALLET_SIGN_FAILED,
          "Albedo returned an empty signed_envelope_xdr.",
        );
      }

      return ok({
        signedXdr,
        ...(result.tx_hash ? { txHash: result.tx_hash } : {}),
        network,
        signerPublicKey: this.currentPublicKey,
      });
    } catch (cause) {
      return classifyAlbedoError(
        "transaction signing",
        cause,
        SorokitErrorCode.WALLET_SIGN_FAILED,
      );
    }
  }

  /**
   * Sign an arbitrary message with the connected Albedo account.
   */
  async signMessage(
    message: string,
  ): Promise<SorokitResult<AlbedoSignedMessage>> {
    if (typeof message !== "string" || message.length === 0) {
      return err(
        SorokitErrorCode.VALIDATION,
        "signMessage requires a non-empty message string.",
      );
    }

    if (typeof this.provider.signMessage !== "function") {
      return err(
        SorokitErrorCode.WALLET_SIGN_FAILED,
        "The configured Albedo provider does not support signMessage.",
      );
    }

    try {
      const result = await this.provider.signMessage({
        message,
        pubkey: this.currentPublicKey,
      });

      const signature = result?.message_signature?.trim() ?? "";
      if (!signature) {
        return err(
          SorokitErrorCode.WALLET_SIGN_FAILED,
          "Albedo returned an empty message signature.",
        );
      }

      return ok({
        message: result.message ?? message,
        publicKey: result.pubkey || this.currentPublicKey,
        messageSignature: signature,
      });
    } catch (cause) {
      return classifyAlbedoError(
        "message signing",
        cause,
        SorokitErrorCode.WALLET_SIGN_FAILED,
      );
    }
  }
}

/**
 * Connect to the Albedo web wallet and initialize an {@link AlbedoSession} (#923).
 */
export async function connectAlbedo(
  options?: AlbedoConnectOptions,
): Promise<SorokitResult<AlbedoSession>> {
  let provider: AlbedoIntentProvider;
  try {
    provider = await resolveAlbedoProvider(options?.provider);
  } catch (cause) {
    return err(
      SorokitErrorCode.WALLET_NOT_FOUND,
      `Albedo provider unavailable: ${toMessage(cause)}`,
      cause,
    );
  }

  try {
    const response = await provider.publicKey(
      options?.requireExisting !== undefined
        ? { require_existing: options.requireExisting }
        : undefined,
    );
    const pubkey = response?.pubkey?.trim() ?? "";
    const validation = validatePublicKey(pubkey);
    if (validation.status === "error") {
      return err(
        SorokitErrorCode.WALLET_CONNECT_FAILED,
        `Albedo returned an invalid public key: ${validation.error.message}`,
      );
    }

    return ok(new AlbedoSession(provider, pubkey, options?.network));
  } catch (cause) {
    return classifyAlbedoError(
      "connection",
      cause,
      SorokitErrorCode.WALLET_CONNECT_FAILED,
    );
  }
}
