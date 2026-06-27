import {
  Horizon,
  TransactionBuilder,
  Operation,
  Asset,
  Memo,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage } from "../shared";
import { DEFAULT_TX_TIMEOUT_SECONDS } from "../shared/constants";
import type { ResolvedNetworkConfig } from "../shared/types";
import type { PaymentParams, TrustlineParams, AccountCreateParams } from "./types";
import { validateIssuer } from "../shared/validateIssuer";

/** Context TTL: 5 minutes */
export const TRANSACTION_CONTEXT_TTL_MS = 5 * 60 * 1000;

/**
 * A pre-fetched builder context that reuses a cached account sequence number
 * and base fee across multiple transaction builds.
 *
 * Obtain via {@link createTransactionContext}.
 */
export interface TransactionBuilderContext {
  /** The source account public key this context was created for. */
  readonly publicKey: string;
  /** Returns `true` when the context is older than 5 minutes. */
  isExpired(): boolean;
  /** Force-expire the context so the next build re-fetches the account. */
  invalidate(): void;
  /** Build a payment transaction XDR, reusing the cached sequence. */
  buildPayment(
    params: PaymentParams,
    trustedIssuers?: string[] | null,
  ): Promise<SorokitResult<string>>;
  /** Build a create-account transaction XDR, reusing the cached sequence. */
  buildCreateAccount(params: AccountCreateParams): Promise<SorokitResult<string>>;
  /** Build a change-trust transaction XDR, reusing the cached sequence. */
  buildTrustline(
    params: TrustlineParams,
    trustedIssuers?: string[] | null,
  ): Promise<SorokitResult<string>>;
}

function resolveMemo(params: { memo?: string; memoType?: string }): SorokitResult<Memo | null> {
  if (!params.memo) return ok(null);
  const type = params.memoType ?? "text";
  try {
    switch (type) {
      case "text":    return ok(Memo.text(params.memo));
      case "id":      return ok(Memo.id(params.memo));
      case "hash":    return ok(Memo.hash(params.memo));
      case "return":  return ok(Memo["return"](params.memo));
      default:
        return err(
          SorokitErrorCode.TX_BUILD_FAILED,
          `Unsupported memo type: ${type}`,
        );
    }
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Invalid memo for type ${type}: ${toMessage(cause)}`,
      cause,
    );
  }
}

/**
 * Create a transaction builder context that pre-fetches the source account
 * (sequence number + network config) once, then reuses the cached data for
 * every subsequent build — avoiding repeated Horizon round trips.
 *
 * The context automatically refreshes after {@link TRANSACTION_CONTEXT_TTL_MS}
 * (5 minutes). Call `invalidate()` to force an early refresh.
 *
 * @example
 * const ctxResult = await createTransactionContext(horizonUrl, networkConfig, publicKey);
 * if (ctxResult.status !== "ok") throw new Error(ctxResult.error.message);
 * const ctx = ctxResult.data;
 *
 * const xdr1 = await ctx.buildPayment({ destination, amount: "10" });
 * const xdr2 = await ctx.buildPayment({ destination, amount: "5" });
 * // Both builds reuse the same pre-fetched account — no extra Horizon calls.
 */
export async function createTransactionContext(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  publicKey: string,
): Promise<SorokitResult<TransactionBuilderContext>> {
  try {
    const server = new Horizon.Server(horizonUrl);
    let currentAccount = await server.loadAccount(publicKey);
    let cachedAt = Date.now();

    async function ensureFresh(): Promise<SorokitResult<void>> {
      if (Date.now() - cachedAt > TRANSACTION_CONTEXT_TTL_MS) {
        try {
          currentAccount = await server.loadAccount(publicKey);
          cachedAt = Date.now();
        } catch (cause) {
          return err(
            SorokitErrorCode.TX_BUILD_FAILED,
            `Failed to refresh transaction context: ${toMessage(cause)}`,
            cause,
          );
        }
      }
      return ok(undefined);
    }

    return ok({
      publicKey,

      isExpired(): boolean {
        return Date.now() - cachedAt > TRANSACTION_CONTEXT_TTL_MS;
      },

      invalidate(): void {
        cachedAt = 0;
      },

      async buildPayment(
        params: PaymentParams,
        trustedIssuers?: string[] | null,
      ): Promise<SorokitResult<string>> {
        const fresh = await ensureFresh();
        if (fresh.status === "error") return fresh;

        // Resolve asset
        let asset: Asset;
        if (!params.assetCode || params.assetCode.toUpperCase() === "XLM") {
          asset = Asset.native();
        } else {
          if (!params.assetIssuer) {
            return err(
              SorokitErrorCode.TX_BUILD_FAILED,
              `Asset issuer is required for non-native asset: ${params.assetCode}`,
            );
          }
          if (trustedIssuers && trustedIssuers.length > 0) {
            try {
              validateIssuer(params.assetIssuer, trustedIssuers);
            } catch (cause) {
              return err(
                SorokitErrorCode.TX_BUILD_FAILED,
                (cause as Error)?.message || String(cause),
                cause,
              );
            }
          }
          asset = new Asset(params.assetCode, params.assetIssuer);
        }

        const memoResult = resolveMemo(params);
        if (memoResult.status === "error") return memoResult;

        try {
          const builder = new TransactionBuilder(currentAccount, {
            fee: BASE_FEE,
            networkPassphrase: networkConfig.networkPassphrase,
          })
            .addOperation(
              Operation.payment({ destination: params.destination, asset, amount: params.amount }),
            )
            .setTimeout(DEFAULT_TX_TIMEOUT_SECONDS);
          if (memoResult.data) builder.addMemo(memoResult.data);
          return ok(builder.build().toXDR());
        } catch (cause) {
          return err(
            SorokitErrorCode.TX_BUILD_FAILED,
            `Failed to build payment transaction: ${toMessage(cause)}`,
            cause,
          );
        }
      },

      async buildCreateAccount(params: AccountCreateParams): Promise<SorokitResult<string>> {
        const fresh = await ensureFresh();
        if (fresh.status === "error") return fresh;

        const memoResult = resolveMemo(params);
        if (memoResult.status === "error") return memoResult;

        try {
          const builder = new TransactionBuilder(currentAccount, {
            fee: BASE_FEE,
            networkPassphrase: networkConfig.networkPassphrase,
          })
            .addOperation(
              Operation.createAccount({
                destination: params.destination,
                startingBalance: params.startingBalance,
              }),
            )
            .setTimeout(DEFAULT_TX_TIMEOUT_SECONDS);
          if (memoResult.data) builder.addMemo(memoResult.data);
          return ok(builder.build().toXDR());
        } catch (cause) {
          return err(
            SorokitErrorCode.TX_BUILD_FAILED,
            `Failed to build create account transaction: ${toMessage(cause)}`,
            cause,
          );
        }
      },

      async buildTrustline(
        params: TrustlineParams,
        trustedIssuers?: string[] | null,
      ): Promise<SorokitResult<string>> {
        const fresh = await ensureFresh();
        if (fresh.status === "error") return fresh;

        if (trustedIssuers && trustedIssuers.length > 0) {
          try {
            validateIssuer(params.assetIssuer, trustedIssuers);
          } catch (cause) {
            return err(
              SorokitErrorCode.TX_BUILD_FAILED,
              (cause as Error)?.message || String(cause),
              cause,
            );
          }
        }

        const memoResult = resolveMemo(params);
        if (memoResult.status === "error") return memoResult;

        try {
          const asset = new Asset(params.assetCode, params.assetIssuer);
          const builder = new TransactionBuilder(currentAccount, {
            fee: BASE_FEE,
            networkPassphrase: networkConfig.networkPassphrase,
          })
            .addOperation(
              Operation.changeTrust({
                asset,
                ...(params.limit !== undefined && { limit: params.limit }),
              }),
            )
            .setTimeout(DEFAULT_TX_TIMEOUT_SECONDS);
          if (memoResult.data) builder.addMemo(memoResult.data);
          return ok(builder.build().toXDR());
        } catch (cause) {
          return err(
            SorokitErrorCode.TX_BUILD_FAILED,
            `Failed to build trustline transaction: ${toMessage(cause)}`,
            cause,
          );
        }
      },
    });
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Failed to create transaction context: ${toMessage(cause)}`,
      cause,
    );
  }
}
