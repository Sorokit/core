/**
 * Ledger hardware wallet adapter.
 *
 * Ledger devices (Nano S/X/S Plus, Stax) expose a Stellar app over USB,
 * Bluetooth, or WebUSB. sorokit-core never talks to Ledger transports
 * directly — the consumer opens the transport (via
 * @ledgerhq/hw-transport-node-hid, @ledgerhq/hw-transport-web-ble, or
 * @ledgerhq/hw-transport-webusb) and instantiates the Stellar app (via
 * @ledgerhq/hw-app-str), then hands the resulting {@link LedgerStellarApp}
 * to `connectLedger()`. This mirrors how FreighterAdapter etc. are handed a
 * consumer-instantiated SWK instance rather than importing SWK themselves.
 *
 * Consumer responsibilities:
 * - Install the relevant @ledgerhq/hw-transport-* and @ledgerhq/hw-app-str packages
 * - Open a transport (USB, Bluetooth, or WebUSB) and open the Stellar app
 * - Pass the opened app to connectLedger()
 * - Provide device selection UI when more than one Ledger is connected (out of scope here)
 */

import { createHash } from "crypto";
import { Keypair, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../../shared/response";
import type { SorokitResult } from "../../shared/response";
import { isTimeoutError, toMessage } from "../../shared";
import type { SignTransactionInput } from "../types";

/** How the consumer's transport reached the device. Informational only — sorokit-core never opens transports itself. */
export type LedgerTransportKind = "usb" | "bluetooth" | "webusb";

/** SLIP-44 BIP32 path prefix for Stellar (coin type 148), per SEP-0005. */
export const STELLAR_LEDGER_BIP32_PATH_PREFIX = "44'/148'";

/** Build the SEP-0005 BIP32 path for a given account index. */
export function ledgerAccountPath(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error("Ledger account index must be a non-negative integer.");
  }
  return `${STELLAR_LEDGER_BIP32_PATH_PREFIX}/${index}'`;
}

/**
 * Minimal contract for an opened Ledger Stellar app instance.
 * Typed locally — sorokit-core never imports @ledgerhq packages at runtime.
 * Satisfied directly by @ledgerhq/hw-app-str's `Str` class.
 */
export interface LedgerStellarApp {
  getPublicKey(path: string, validate?: boolean, display?: boolean): Promise<{ publicKey: string }>;
  signTransaction(path: string, transaction: Buffer | Uint8Array): Promise<{ signature: Buffer | Uint8Array }>;
  /** Optional: not every firmware/app version exposes hash signing (used here for signMessage). */
  signHash?(path: string, hash: Buffer | Uint8Array): Promise<{ signature: Buffer | Uint8Array }>;
  transport: {
    close(): Promise<void>;
  };
}

export interface LedgerConnectOptions {
  /** Which physical transport the consumer opened the app over. Defaults to "usb". */
  transportKind?: LedgerTransportKind;
}

/** A Ledger account derived at a given SEP-0005 BIP32 index. */
export interface LedgerAccount {
  index: number;
  path: string;
  publicKey: string;
}

function describeLedgerFailure(action: "connection" | "account retrieval" | "signing", cause: unknown): string {
  if (isTimeoutError(cause)) {
    return `Ledger ${action} timed out: ${toMessage(cause)}. Ensure the device is unlocked with the Stellar app open.`;
  }
  return `Ledger ${action} failed: ${toMessage(cause)}`;
}

function toBuffer(data: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

/**
 * An active session against a connected Ledger device's Stellar app.
 * Returned by {@link connectLedger}.
 */
export class LedgerSession {
  readonly provider = "LEDGER";
  readonly transportKind: LedgerTransportKind;

  constructor(
    private readonly app: LedgerStellarApp,
    transportKind: LedgerTransportKind = "usb",
  ) {
    this.transportKind = transportKind;
  }

  /**
   * Derive and return the account at the given SEP-0005 index.
   * Does not require on-device confirmation (`display: false`) — pass
   * `verify: true` to have the user confirm the address on the device screen.
   */
  async getLedgerAccount(index = 0, verify = false): Promise<SorokitResult<LedgerAccount>> {
    let path: string;
    try {
      path = ledgerAccountPath(index);
    } catch (cause) {
      return err(SorokitErrorCode.WALLET_CONNECT_FAILED, toMessage(cause), cause);
    }

    try {
      const { publicKey } = await this.app.getPublicKey(path, verify, verify);
      return ok({ index, path, publicKey });
    } catch (cause) {
      return err(
        SorokitErrorCode.WALLET_CONNECT_FAILED,
        describeLedgerFailure("account retrieval", cause),
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
      path = ledgerAccountPath(accountIndex);
    } catch (cause) {
      return err(SorokitErrorCode.WALLET_SIGN_FAILED, toMessage(cause), cause);
    }

    const accountResult = await this.getLedgerAccount(accountIndex);
    if (accountResult.status === "error") return accountResult;
    const account = accountResult.data;

    if (input.accountToSign && input.accountToSign !== account.publicKey) {
      return err(
        SorokitErrorCode.WALLET_SIGN_FAILED,
        `signTransaction: requested signer ${input.accountToSign} does not match Ledger account ${account.publicKey} at index ${accountIndex}.`,
      );
    }

    let signatureBase: Buffer;
    try {
      const transaction = TransactionBuilder.fromXDR(input.transactionXdr, input.networkPassphrase);
      signatureBase = transaction.signatureBase();
    } catch (cause) {
      return err(
        SorokitErrorCode.XDR_INVALID,
        `signTransaction: invalid transaction XDR — ${toMessage(cause)}`,
        cause,
      );
    }

    try {
      const { signature } = await this.app.signTransaction(path, signatureBase);
      const keypair = Keypair.fromPublicKey(account.publicKey);
      const decoratedSignature = new xdr.DecoratedSignature({
        hint: keypair.signatureHint(),
        signature: toBuffer(signature),
      });

      const envelope = xdr.TransactionEnvelope.fromXDR(input.transactionXdr, "base64");
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

      return ok(envelope.toXDR("base64"));
    } catch (cause) {
      const rejected = /reject|denied|0x6985/i.test(toMessage(cause));
      return err(
        rejected ? SorokitErrorCode.WALLET_SIGN_REJECTED : SorokitErrorCode.WALLET_SIGN_FAILED,
        rejected
          ? "User rejected the Ledger signature request."
          : describeLedgerFailure("signing", cause),
        cause,
      );
    }
  }

  /**
   * Sign an arbitrary message's SHA-256 hash on the device.
   * Requires the opened app to expose `signHash` — most Stellar app builds
   * only support signing transaction hashes, not free-form messages, so this
   * returns WALLET_SIGN_FAILED when unsupported.
   */
  async signMessage(message: string, accountIndex = 0): Promise<SorokitResult<string>> {
    if (typeof this.app.signHash !== "function") {
      return err(
        SorokitErrorCode.WALLET_SIGN_FAILED,
        "signMessage: the connected Ledger Stellar app does not support hash signing.",
      );
    }

    let path: string;
    try {
      path = ledgerAccountPath(accountIndex);
    } catch (cause) {
      return err(SorokitErrorCode.WALLET_SIGN_FAILED, toMessage(cause), cause);
    }

    try {
      const hash = createHash("sha256").update(message, "utf8").digest();
      const { signature } = await this.app.signHash(path, hash);
      return ok(toBuffer(signature).toString("base64"));
    } catch (cause) {
      const rejected = /reject|denied|0x6985/i.test(toMessage(cause));
      return err(
        rejected ? SorokitErrorCode.WALLET_SIGN_REJECTED : SorokitErrorCode.WALLET_SIGN_FAILED,
        rejected
          ? "User rejected the Ledger signature request."
          : describeLedgerFailure("signing", cause),
        cause,
      );
    }
  }

  /** Close the underlying transport. */
  async disconnect(): Promise<SorokitResult<undefined>> {
    try {
      await this.app.transport.close();
      return ok(undefined);
    } catch (cause) {
      return err(SorokitErrorCode.WALLET_CONNECT_FAILED, describeLedgerFailure("connection", cause), cause);
    }
  }
}

/**
 * Connect to a Ledger device's Stellar app.
 *
 * `openApp` is supplied by the consumer and is responsible for locating the
 * device (USB, Bluetooth, or WebUSB) and opening the Stellar app — sorokit-core
 * never performs device discovery itself. This keeps the SDK free of a hard
 * dependency on any specific @ledgerhq transport package.
 *
 * @example
 * import Str from "@ledgerhq/hw-app-str";
 * import TransportWebUSB from "@ledgerhq/hw-transport-webusb";
 *
 * const ledgerResult = await connectLedger(async () => {
 *   const transport = await TransportWebUSB.create();
 *   return new Str(transport);
 * }, { transportKind: "webusb" });
 *
 * if (ledgerResult.status === "ok") {
 *   const account = await ledgerResult.data.getLedgerAccount(0);
 * }
 */
export async function connectLedger(
  openApp: () => Promise<LedgerStellarApp>,
  options?: LedgerConnectOptions,
): Promise<SorokitResult<LedgerSession>> {
  try {
    const app = await openApp();
    return ok(new LedgerSession(app, options?.transportKind ?? "usb"));
  } catch (cause) {
    return err(SorokitErrorCode.WALLET_NOT_FOUND, describeLedgerFailure("connection", cause), cause);
  }
}
