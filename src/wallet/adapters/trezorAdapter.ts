/**
 * Trezor hardware wallet adapter.
 *
 * Trezor devices expose Stellar signing through Trezor Connect, which talks
 * to the device over USB, WebUSB, or Trezor Bridge and — unlike Ledger's
 * Stellar app — decodes and displays transaction details on-device rather
 * than blind-signing a raw signature base. sorokit-core never imports
 * @trezor/connect directly — the consumer opens/initialises Trezor Connect
 * and hands `connectTrezor()` a thin {@link TrezorStellarApi} wrapper around
 * it, mirroring how FreighterAdapter is handed a consumer-instantiated SWK
 * instance and ledgerAdapter.ts is handed a consumer-opened Ledger app.
 *
 * Consumer responsibilities:
 * - Install @trezor/connect (or @trezor/connect-web) and initialise it
 *   (`TrezorConnect.init({ transports: [...] })`)
 * - Implement {@link TrezorStellarApi}: `getAddress` maps to
 *   `TrezorConnect.stellarGetAddress`; `signTransaction` decodes the given
 *   XDR into Trezor Connect's structured `stellarSignTransaction` payload,
 *   calls it, and returns the raw ed25519 signature
 * - Pass the wrapper to connectTrezor()
 * - Provide device selection UI when more than one Trezor is connected (out of scope here)
 */

import { createHash } from "crypto";
import { Keypair, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../../shared/response";
import type { SorokitResult } from "../../shared/response";
import { isTimeoutError, toMessage } from "../../shared";
import type { SignTransactionInput } from "../types";

/** How Trezor Connect reached the device. Informational only — sorokit-core never opens transports itself. */
export type TrezorTransportKind = "usb" | "webusb" | "bridge";

/** SLIP-44 BIP32 path prefix for Stellar (coin type 148), per SEP-0005, in Trezor Connect's `m/`-prefixed string form. */
export const STELLAR_TREZOR_BIP32_PATH_PREFIX = "m/44'/148'";

/** Build the SEP-0005 BIP32 path for a given account index, in the string form Trezor Connect expects. */
export function trezorAccountPath(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error("Trezor account index must be a non-negative integer.");
  }
  return `${STELLAR_TREZOR_BIP32_PATH_PREFIX}/${index}'`;
}

/**
 * Minimal contract for a consumer-provided Trezor Connect wrapper.
 * Typed locally — sorokit-core never imports @trezor/connect at runtime.
 */
export interface TrezorStellarApi {
  getAddress(path: string, showOnTrezor?: boolean): Promise<{ address: string }>;

  /**
   * Sign a Stellar transaction on the device.
   * Trezor devices parse and display the transaction rather than
   * blind-signing a raw signature base, so this method receives the full
   * XDR + network passphrase and is responsible for converting it into
   * Trezor Connect's structured `stellarSignTransaction` request; it should
   * return only the raw 64-byte ed25519 signature.
   */
  signTransaction(
    path: string,
    transactionXdr: string,
    networkPassphrase: string,
  ): Promise<{ signature: Buffer | Uint8Array }>;

  /** Optional: current Trezor Connect Stellar methods do not expose generic hash signing. */
  signHash?(path: string, hash: Buffer | Uint8Array): Promise<{ signature: Buffer | Uint8Array }>;

  /** Tear down the Trezor Connect popup/iframe (`TrezorConnect.dispose()`). */
  dispose(): Promise<void> | void;
}

export interface TrezorConnectOptions {
  /** Which physical transport Trezor Connect was configured to use. Defaults to "bridge". */
  transportKind?: TrezorTransportKind;
}

/** A Trezor account derived at a given SEP-0005 BIP32 index. */
export interface TrezorAccount {
  index: number;
  path: string;
  publicKey: string;
}

function describeTrezorFailure(action: "connection" | "account retrieval" | "signing", cause: unknown): string {
  if (isTimeoutError(cause)) {
    return `Trezor ${action} timed out: ${toMessage(cause)}. Ensure the device is unlocked and Trezor Bridge is running.`;
  }
  return `Trezor ${action} failed: ${toMessage(cause)}`;
}

function toBuffer(data: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

function appendDecoratedSignature(envelopeXdr: string, decoratedSignature: xdr.DecoratedSignature): string {
  const envelope = xdr.TransactionEnvelope.fromXDR(envelopeXdr, "base64");
  switch (envelope.switch()) {
    case xdr.EnvelopeType.envelopeTypeTxV0():
      envelope.v0().signatures([...envelope.v0().signatures(), decoratedSignature]);
      break;
    case xdr.EnvelopeType.envelopeTypeTx():
      envelope.v1().signatures([...envelope.v1().signatures(), decoratedSignature]);
      break;
    case xdr.EnvelopeType.envelopeTypeTxFeeBump():
      envelope.feeBump().signatures([...envelope.feeBump().signatures(), decoratedSignature]);
      break;
    default:
      throw new Error("Unsupported transaction envelope type.");
  }
  return envelope.toXDR("base64");
}

/**
 * An active session against a connected Trezor device's Stellar app.
 * Returned by {@link connectTrezor}.
 */
export class TrezorSession {
  readonly provider = "TREZOR";
  readonly transportKind: TrezorTransportKind;

  constructor(
    private readonly api: TrezorStellarApi,
    transportKind: TrezorTransportKind = "bridge",
  ) {
    this.transportKind = transportKind;
  }

  /**
   * Derive and return the account at the given SEP-0005 index.
   * Does not require on-device confirmation (`showOnTrezor: false`) — pass
   * `verify: true` to have the user confirm the address on the device screen.
   */
  async getTrezorAccount(index = 0, verify = false): Promise<SorokitResult<TrezorAccount>> {
    let path: string;
    try {
      path = trezorAccountPath(index);
    } catch (cause) {
      return err(SorokitErrorCode.WALLET_CONNECT_FAILED, toMessage(cause), cause);
    }

    try {
      const { address } = await this.api.getAddress(path, verify);
      return ok({ index, path, publicKey: address });
    } catch (cause) {
      return err(
        SorokitErrorCode.WALLET_CONNECT_FAILED,
        describeTrezorFailure("account retrieval", cause),
        cause,
      );
    }
  }

  /**
   * Sign a transaction XDR on the device and return the signed XDR.
   * `input.accountToSign` selects the signing public key (must match the
   * account at `accountIndex`); defaults to index 0.
   */
  async signTransaction(
    input: SignTransactionInput & { accountIndex?: number },
  ): Promise<SorokitResult<string>> {
    const accountIndex = input.accountIndex ?? 0;
    let path: string;
    try {
      path = trezorAccountPath(accountIndex);
    } catch (cause) {
      return err(SorokitErrorCode.WALLET_SIGN_FAILED, toMessage(cause), cause);
    }

    const accountResult = await this.getTrezorAccount(accountIndex);
    if (accountResult.status === "error") return accountResult;
    const account = accountResult.data;

    if (input.accountToSign && input.accountToSign !== account.publicKey) {
      return err(
        SorokitErrorCode.WALLET_SIGN_FAILED,
        `signTransaction: requested signer ${input.accountToSign} does not match Trezor account ${account.publicKey} at index ${accountIndex}.`,
      );
    }

    try {
      TransactionBuilder.fromXDR(input.transactionXdr, input.networkPassphrase);
    } catch (cause) {
      return err(
        SorokitErrorCode.XDR_INVALID,
        `signTransaction: invalid transaction XDR — ${toMessage(cause)}`,
        cause,
      );
    }

    try {
      const { signature } = await this.api.signTransaction(path, input.transactionXdr, input.networkPassphrase);
      const keypair = Keypair.fromPublicKey(account.publicKey);
      const decoratedSignature = new xdr.DecoratedSignature({
        hint: keypair.signatureHint(),
        signature: toBuffer(signature),
      });

      return ok(appendDecoratedSignature(input.transactionXdr, decoratedSignature));
    } catch (cause) {
      const rejected = /cancel|reject|denied/i.test(toMessage(cause));
      return err(
        rejected ? SorokitErrorCode.WALLET_SIGN_REJECTED : SorokitErrorCode.WALLET_SIGN_FAILED,
        rejected
          ? "User rejected the Trezor signature request."
          : describeTrezorFailure("signing", cause),
        cause,
      );
    }
  }

  /**
   * Sign an arbitrary message's SHA-256 hash on the device.
   * Requires the wrapper to expose `signHash` — current Trezor Connect
   * Stellar methods do not support free-form message signing, so this
   * returns WALLET_SIGN_FAILED when unsupported.
   */
  async signMessage(message: string, accountIndex = 0): Promise<SorokitResult<string>> {
    if (typeof this.api.signHash !== "function") {
      return err(
        SorokitErrorCode.WALLET_SIGN_FAILED,
        "signMessage: the connected Trezor wrapper does not support hash signing.",
      );
    }

    let path: string;
    try {
      path = trezorAccountPath(accountIndex);
    } catch (cause) {
      return err(SorokitErrorCode.WALLET_SIGN_FAILED, toMessage(cause), cause);
    }

    try {
      const hash = createHash("sha256").update(message, "utf8").digest();
      const { signature } = await this.api.signHash(path, hash);
      return ok(toBuffer(signature).toString("base64"));
    } catch (cause) {
      const rejected = /cancel|reject|denied/i.test(toMessage(cause));
      return err(
        rejected ? SorokitErrorCode.WALLET_SIGN_REJECTED : SorokitErrorCode.WALLET_SIGN_FAILED,
        rejected
          ? "User rejected the Trezor signature request."
          : describeTrezorFailure("signing", cause),
        cause,
      );
    }
  }

  /** Tear down the underlying Trezor Connect popup/iframe. */
  async disconnect(): Promise<SorokitResult<undefined>> {
    try {
      await this.api.dispose();
      return ok(undefined);
    } catch (cause) {
      return err(SorokitErrorCode.WALLET_CONNECT_FAILED, describeTrezorFailure("connection", cause), cause);
    }
  }
}

/**
 * Connect to a Trezor device's Stellar signing API.
 *
 * `openApi` is supplied by the consumer and is responsible for initialising
 * Trezor Connect (USB, WebUSB, or Bridge) and returning a wrapper satisfying
 * {@link TrezorStellarApi} — sorokit-core never performs device discovery or
 * transaction-schema conversion itself. This keeps the SDK free of a hard
 * dependency on any specific @trezor/connect package.
 *
 * @example
 * import TrezorConnect from "@trezor/connect-web";
 *
 * const trezorResult = await connectTrezor(async () => {
 *   await TrezorConnect.init({ lazyLoad: true, manifest: { email, appUrl } });
 *   return {
 *     getAddress: async (path, showOnTrezor) => {
 *       const r = await TrezorConnect.stellarGetAddress({ path, showOnTrezor });
 *       if (!r.success) throw new Error(r.payload.error);
 *       return { address: r.payload.address };
 *     },
 *     signTransaction: async (path, transactionXdr, networkPassphrase) => {
 *       // decode transactionXdr into TrezorConnect.stellarSignTransaction's
 *       // structured `tx` payload and call it here.
 *     },
 *     dispose: () => TrezorConnect.dispose(),
 *   };
 * }, { transportKind: "bridge" });
 *
 * if (trezorResult.status === "ok") {
 *   const account = await trezorResult.data.getTrezorAccount(0);
 * }
 */
export async function connectTrezor(
  openApi: () => Promise<TrezorStellarApi>,
  options?: TrezorConnectOptions,
): Promise<SorokitResult<TrezorSession>> {
  try {
    const api = await openApi();
    return ok(new TrezorSession(api, options?.transportKind ?? "bridge"));
  } catch (cause) {
    return err(SorokitErrorCode.WALLET_NOT_FOUND, describeTrezorFailure("connection", cause), cause);
  }
}
