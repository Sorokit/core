/** Rabet extension API adapter: https://docs.rabet.io/api/api-refrence */
import { WalletType } from "../types";
import type { WalletAdapter, SignTransactionInput, SWKInstance } from "../types";
import { ok, err, SorokitErrorCode } from "../../shared/response";
import type { SorokitResult } from "../../shared/response";
import { isUserRejection } from "../../shared";

/** The API injected by the Rabet extension. No package import is required. */
export interface RabetProvider {
  connect(): Promise<{ publicKey?: string; error?: string } | string>;
  disconnect?(): Promise<void> | void;
  sign(
    xdr: string,
    network: "mainnet" | "testnet",
  ): Promise<{ xdr?: string; signedTxXdr?: string; error?: string } | string>;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function failure<T>(
  action: "connection" | "signing" | "disconnect",
  cause: unknown,
): SorokitResult<T> {
  // Extension errors are untrusted; even inspecting one can throw (e.g. a Proxy).
  let rejected = false;
  try {
    rejected = isUserRejection(cause);
  } catch {
    // Keep the operation-specific error for unrecognizable payloads.
  }
  return err(
    rejected ? SorokitErrorCode.WALLET_SIGN_REJECTED
      : action === "signing" ? SorokitErrorCode.WALLET_SIGN_FAILED
      : SorokitErrorCode.WALLET_CONNECT_FAILED,
    rejected ? `User rejected the Rabet ${action} request.` : `Rabet ${action} failed.`,
    cause,
  );
}

export class RabetAdapter implements WalletAdapter {
  readonly walletType = WalletType.RABET;

  constructor(private readonly provider?: RabetProvider | SWKInstance) {}

  private resolveProvider(): RabetProvider | SWKInstance | undefined {
    if (this.provider) return this.provider;
    if (typeof window === "undefined") return undefined;
    return (window as unknown as { rabet?: RabetProvider }).rabet;
  }

  isAvailable(): boolean {
    try {
      const provider = this.resolveProvider();
      return !!provider && (
        ("getAddress" in provider && typeof provider.getAddress === "function"
          && "signTransaction" in provider && typeof provider.signTransaction === "function")
        || ("connect" in provider && typeof provider.connect === "function"
          && "sign" in provider && typeof provider.sign === "function")
      );
    } catch {
      return false;
    }
  }

  async connect(): Promise<SorokitResult<string>> {
    try {
      const provider = this.resolveProvider();
      if (!provider) return this.unavailable();
      let publicKey: unknown;
      if ("getAddress" in provider) {
        publicKey = (await provider.getAddress())?.address;
      } else {
        const result = await provider.connect();
        if (typeof result === "object" && result?.error) {
          return failure("connection", result.error);
        }
        publicKey = typeof result === "string" ? result : result?.publicKey;
      }
      return nonEmptyString(publicKey)
        ? ok(publicKey)
        : err(SorokitErrorCode.WALLET_CONNECT_FAILED, "Rabet returned an invalid public key.");
    } catch (cause) {
      return failure("connection", cause);
    }
  }

  async disconnect(): Promise<SorokitResult<undefined>> {
    try {
      const provider = this.resolveProvider();
      if (provider && "disconnect" in provider && typeof provider.disconnect === "function") {
        await provider.disconnect();
      }
      // WalletState and cached connection state are cleared by disconnectWallet.
      // SWK does not expose a disconnect method; no adapter-local state is retained.
      return ok(undefined);
    } catch (cause) {
      return failure("disconnect", cause);
    }
  }

  async signTransaction(input: SignTransactionInput): Promise<SorokitResult<string>> {
    try {
      const provider = this.resolveProvider();
      if (!provider) return this.unavailable();
      let signedXdr: unknown;
      if ("getAddress" in provider) {
        const result = await provider.signTransaction(input.transactionXdr, {
          networkPassphrase: input.networkPassphrase,
          ...(input.accountToSign !== undefined ? { address: input.accountToSign } : {}),
        });
        signedXdr = result?.signedTxXdr;
      } else {
        const passphrase = input.networkPassphrase.trim();
        if (passphrase !== "Public Global Stellar Network ; September 2015"
          && passphrase !== "Test SDF Network ; September 2015") {
          return err(SorokitErrorCode.INVALID_NETWORK, "Rabet supports only Stellar mainnet and testnet.");
        }
        const network = passphrase === "Public Global Stellar Network ; September 2015"
          ? "mainnet" : "testnet";
        const result = await provider.sign(input.transactionXdr, network);
        if (typeof result === "object" && result?.error) {
          return failure("signing", result.error);
        }
        signedXdr = typeof result === "string" ? result : result?.xdr ?? result?.signedTxXdr;
      }
      return nonEmptyString(signedXdr)
        ? ok(signedXdr)
        : err(SorokitErrorCode.WALLET_SIGN_FAILED, "Rabet returned an invalid signed transaction XDR.");
    } catch (cause) {
      return failure("signing", cause);
    }
  }

  private unavailable<T>(): SorokitResult<T> {
    return err(SorokitErrorCode.WALLET_BROWSER_ONLY, "Rabet requires an injected provider or the Rabet extension.");
  }
}
