import {
  TransactionBuilder,
  Operation,
  Asset,
  Memo,
  Account,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage } from "../shared";
import { DEFAULT_TX_TIMEOUT_SECONDS } from "../shared/constants";
import type { ResolvedNetworkConfig } from "../shared/types";
import type { PaymentParams, TrustlineParams, AccountCreateParams, MemoParams } from "./types";
import { validateIssuer } from "../shared/validateIssuer";
import { createHorizonServer } from "../shared/serverFactory";
import { validateMemoPolicy } from "./buildTransaction";

/** Context TTL: 5 minutes */
export const TRANSACTION_CONTEXT_TTL_MS = 5 * 60 * 1000;

/**
 * Structured outcome of a fresh-sequence validation (#394).
 */
export interface SequenceValidationResult {
  /** `true` when the on-ledger sequence matches the next sequence the context will assign. */
  valid: boolean;
  /** Next sequence number the context will assign to a new transaction. */
  expectedSequence: string;
  /** Current on-ledger sequence number observed at validation time. */
  networkSequence: string;
}

/**
 * A pre-fetched builder context that reuses a cached account sequence number
 * and base fee across multiple transaction builds.
 *
 * Every build consumes the next sequence from an in-memory counter so that
 * sequential transactions never collide on the same sequence (#394).
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
  /**
   * Peek the next sequence number the context will assign without consuming it.
   */
  peekNextSequence(): string;
  /**
   * Re-fetch the source account from Horizon and verify the context's next
   * sequence still matches the on-ledger state. Call before submitting to
   * detect stale sequences or conflicts with transactions submitted outside
   * of this context. Returns TX_SEQUENCE_CONFLICT when they diverge.
   */
  validateFreshSequence(): Promise<SorokitResult<SequenceValidationResult>>;
  /**
   * Reset the context: re-fetch the account from Horizon and adopt its
   * sequence (never regressing below any already-assigned sequence).
   */
  reset(): Promise<SorokitResult<SequenceValidationResult>>;
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

function resolveMemo(params: MemoParams): SorokitResult<Memo | null> {
  const policyResult = validateMemoPolicy(params);
  if (policyResult.status === "error") return policyResult;

  const allowEmpty =
    params.allowEmptyMemo === true ||
    (typeof params.memoValidation === "object" &&
      params.memoValidation !== null &&
      params.memoValidation.allowEmpty === true);

  if (!params.memo) {
    if (params.memo === "" && allowEmpty) {
      const type = params.memoType ?? "text";
      try {
        if (type === "text") return ok(Memo.text(""));
      } catch {
        // Fall through
      }
    }
    return ok(null);
  }
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

function loadNetworkSequence(server: { loadAccount(publicKey: string): Promise<{ sequenceNumber(): string }> }, publicKey: string): Promise<string> {
  return server.loadAccount(publicKey).then((account) => account.sequenceNumber());
}

/**
 * Create a transaction builder context that pre-fetches the source account
 * (sequence number + network config) once, then maintains an in-memory
 * sequence counter for every subsequent build — avoiding repeated Horizon
 * round trips while guaranteeing unique sequence numbers (#394).
 *
 * The context automatically refreshes after {@link TRANSACTION_CONTEXT_TTL_MS}
 * (5 minutes). Call `invalidate()` or `reset()` to force an early refresh.
 *
 * @example
 * const ctxResult = await createTransactionContext(horizonUrl, networkConfig, publicKey);
 * if (ctxResult.status !== "ok") throw new Error(ctxResult.error.message);
 * const ctx = ctxResult.data;
 *
 * const xdr1 = await ctx.buildPayment({ destination, amount: "10" }); // seq N
 * const xdr2 = await ctx.buildPayment({ destination, amount: "5" });  // seq N+1
 *
 * // Optional: verify no conflicting transaction landed before submitting.
 * const check = await ctx.validateFreshSequence();
 */
export async function createTransactionContext(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  publicKey: string,
): Promise<SorokitResult<TransactionBuilderContext>> {
  try {
    const server = createHorizonServer(horizonUrl) as unknown as {
      loadAccount(publicKey: string): Promise<{ sequenceNumber(): string }>;
    };
    const initialAccount = await server.loadAccount(publicKey);
    let nextSequence = BigInt(initialAccount.sequenceNumber());
    let cachedAt = Date.now();

    async function refresh(): Promise<SorokitResult<void>> {
      try {
        const networkSequence = await loadNetworkSequence(server, publicKey);
        // Never regress below sequences already handed out by this context.
        nextSequence =
          BigInt(networkSequence) > nextSequence
            ? BigInt(networkSequence)
            : nextSequence;
        cachedAt = Date.now();
      } catch (cause) {
        return err(
          SorokitErrorCode.TX_BUILD_FAILED,
          `Failed to refresh transaction context: ${toMessage(cause)}`,
          cause,
        );
      }
      return ok(undefined);
    }

    async function ensureFresh(): Promise<SorokitResult<void>> {
      if (Date.now() - cachedAt > TRANSACTION_CONTEXT_TTL_MS) {
        const refreshed = await refresh();
        if (refreshed.status === "error") return refreshed;
      }
      return ok(undefined);
    }

    function fetchFreshSequence(): Promise<string> {
      return loadNetworkSequence(server, publicKey);
    }

    return ok({
      publicKey,

      isExpired(): boolean {
        return Date.now() - cachedAt > TRANSACTION_CONTEXT_TTL_MS;
      },

      invalidate(): void {
        cachedAt = 0;
      },

      peekNextSequence(): string {
        return nextSequence.toString();
      },

      async validateFreshSequence(): Promise<SorokitResult<SequenceValidationResult>> {
        let networkSequenceStr: string;
        try {
          networkSequenceStr = await fetchFreshSequence();
        } catch (cause) {
          return err(
            SorokitErrorCode.TX_BUILD_FAILED,
            `Failed to fetch fresh sequence for validation: ${toMessage(cause)}`,
            cause,
          );
        }

        // nextSequence is the base the next build will consume; a pending tx
        // applies when the ledger sits exactly at its base value.
        const expectedSequence = nextSequence.toString();
        const fetched = BigInt(networkSequenceStr);

        if (fetched > nextSequence) {
          return err(
            SorokitErrorCode.TX_SEQUENCE_CONFLICT,
            `Sequence conflict: context expects ${expectedSequence} but the network reports ${networkSequenceStr}. Another transaction consumed this sequence — reset() the context before building again.`,
            { expectedSequence, networkSequence: networkSequenceStr },
          );
        }

        return ok({
          valid: fetched === nextSequence,
          expectedSequence,
          networkSequence: networkSequenceStr,
        });
      },

      async reset(): Promise<SorokitResult<SequenceValidationResult>> {
        let networkSequenceStr: string;
        try {
          networkSequenceStr = await fetchFreshSequence();
        } catch (cause) {
          return err(
            SorokitErrorCode.TX_BUILD_FAILED,
            `Failed to reset transaction context: ${toMessage(cause)}`,
            cause,
          );
        }
        // Never regress below sequences already handed out by this context.
        const fetched = BigInt(networkSequenceStr);
        if (fetched > nextSequence) nextSequence = fetched;
        cachedAt = Date.now();
        return ok({
          valid: true,
          expectedSequence: nextSequence.toString(),
          networkSequence: networkSequenceStr,
        });
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

        // Allocate the sequence synchronously so concurrent builds never collide.
        const assignedSequence = nextSequence;
        const sourceAccount = new Account(publicKey, assignedSequence.toString());

        try {
          const builder = new TransactionBuilder(sourceAccount, {
            fee: BASE_FEE,
            networkPassphrase: networkConfig.networkPassphrase,
          })
            .addOperation(
              Operation.payment({ destination: params.destination, asset, amount: params.amount }),
            )
            .setTimeout(DEFAULT_TX_TIMEOUT_SECONDS);
          if (memoResult.data) builder.addMemo(memoResult.data);
          const xdr = builder.build().toXDR();
          nextSequence = assignedSequence + 1n;
          return ok(xdr);
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

        const assignedSequence = nextSequence;
        const sourceAccount = new Account(publicKey, assignedSequence.toString());

        try {
          const builder = new TransactionBuilder(sourceAccount, {
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
          const xdr = builder.build().toXDR();
          nextSequence = assignedSequence + 1n;
          return ok(xdr);
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

        const assignedSequence = nextSequence;
        const sourceAccount = new Account(publicKey, assignedSequence.toString());

        try {
          const asset = new Asset(params.assetCode, params.assetIssuer);
          const builder = new TransactionBuilder(sourceAccount, {
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
          const xdr = builder.build().toXDR();
          nextSequence = assignedSequence + 1n;
          return ok(xdr);
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
