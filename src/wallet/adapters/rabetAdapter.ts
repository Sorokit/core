/**
 * Rabet Wallet Adapter Helper — Support Rabet Extension (#924)
 *
 * Standalone connection and signing helpers for the Rabet Stellar browser extension.
 */

import { err, ok, SorokitErrorCode } from "../../shared/response";
import type { SorokitResult } from "../../shared/response";
import { RabetAdapter, type RabetProvider } from "./rabet";

export interface RabetConnectionResult {
  publicKey: string;
}

export interface RabetSignedTxResult {
  signedXdr: string;
}

function resolveProvider(customProvider?: RabetProvider): RabetProvider | undefined {
  if (customProvider) return customProvider;
  if (typeof window !== "undefined") {
    return (window as unknown as { rabet?: RabetProvider }).rabet;
  }
  return undefined;
}

/**
 * Connect to the Rabet extension wallet.
 */
export async function connectRabet(
  provider?: RabetProvider,
): Promise<SorokitResult<RabetConnectionResult>> {
  try {
    const p = resolveProvider(provider);
    if (!p) {
      return err(
        SorokitErrorCode.WALLET_NOT_FOUND,
        "Rabet extension is not installed or not available in the current window context",
      );
    }

    const adapter = new RabetAdapter(p);
    const conn = await adapter.connect();
    if (conn.status === "error") {
      return conn;
    }

    return ok({
      publicKey: conn.data,
    });
  } catch (cause) {
    return err(
      SorokitErrorCode.WALLET_CONNECT_FAILED,
      cause instanceof Error ? cause.message : "Failed to connect to Rabet extension",
      cause,
    );
  }
}

/**
 * Retrieve the active account public key from Rabet.
 */
export async function getRabetAccount(
  provider?: RabetProvider,
): Promise<SorokitResult<string>> {
  try {
    const conn = await connectRabet(provider);
    if (conn.status === "error") {
      return conn;
    }
    return ok(conn.data.publicKey);
  } catch (cause) {
    return err(
      SorokitErrorCode.WALLET_CONNECT_FAILED,
      cause instanceof Error ? cause.message : "Failed to retrieve account from Rabet",
      cause,
    );
  }
}

/**
 * Sign a transaction XDR string with Rabet.
 */
export async function signRabetTransaction(
  xdrString: string,
  network: "mainnet" | "testnet" = "testnet",
  provider?: RabetProvider,
): Promise<SorokitResult<RabetSignedTxResult>> {
  try {
    const p = resolveProvider(provider);
    if (!p) {
      return err(
        SorokitErrorCode.WALLET_NOT_FOUND,
        "Rabet extension is not installed or not available in the current window context",
      );
    }

    const adapter = new RabetAdapter(p);
    const networkPassphrase =
      network === "mainnet"
        ? "Public Global Stellar Network ; September 2015"
        : "Test SDF Network ; September 2015";

    const signRes = await adapter.signTransaction({
      transactionXdr: xdrString,
      networkPassphrase,
    });

    if (signRes.status === "error") {
      return signRes;
    }

    return ok({
      signedXdr: signRes.data,
    });
  } catch (cause) {
    return err(
      SorokitErrorCode.WALLET_SIGN_FAILED,
      cause instanceof Error ? cause.message : "Rabet transaction signing failed",
      cause,
    );
  }
}
