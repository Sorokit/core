/**
 * Wallet module public types.
 *
 * All wallet-related types live here.
 * No other module imports wallet types directly — they go through this file.
 */

import type { SorokitResult } from "../shared/response";

export enum WalletType {
  FREIGHTER = "FREIGHTER",
  XBULL = "XBULL",
  LOBSTR = "LOBSTR",
  HANA = "HANA",
  RABET = "RABET",
}

export interface WalletState {
  connected: boolean;
  publicKey: string | null;
  walletType: WalletType | null;
}

export interface SignTransactionInput {
  /** XDR-encoded transaction to sign */
  transactionXdr: string;
  /** Network passphrase — required by all Stellar wallets */
  networkPassphrase: string;
  /** Optional: specific account to sign as (multisig scenarios) */
  accountToSign?: string;
  /** Optional: list of signer public keys expected to co-sign this transaction */
  signers?: string[];
}

/**
 * WalletAdapter — the enforced contract every wallet integration must satisfy.
 *
 * Rules:
 * - Every method returns SorokitResult<T> — no throws, no raw returns
 * - isAvailable() is the only synchronous method — it cannot fail
 * - connect() returns the public key string on success
 * - disconnect() returns void on success
 * - signTransaction() returns the signed XDR string on success
 */
export interface WalletAdapter {
  /** Identifies which wallet this adapter handles */
  readonly walletType: WalletType;

  /** Returns false in Node or when the wallet extension is not installed */
  isAvailable(): boolean;

  /** Connect and return the user's public key */
  connect(): Promise<SorokitResult<string>>;

  /** Disconnect — state cleanup is the consumer's responsibility */
  disconnect(): Promise<SorokitResult<void>>;

  /** Sign a transaction XDR and return the signed XDR */
  signTransaction(input: SignTransactionInput): Promise<SorokitResult<string>>;
}

/**
 * Minimal interface required from a Stellar Wallets Kit instance.
 * Typed locally — sorokit-core never imports SWK at runtime.
 * SWK is a peer dependency instantiated by the consumer.
 */
export interface SWKInstance {
  getAddress(): Promise<{ address: string }>;
  signTransaction(
    xdr: string,
    opts: { networkPassphrase: string; address?: string },
  ): Promise<{ signedTxXdr: string }>;
}
