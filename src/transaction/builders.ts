/**
 * Fluent single-operation transaction builders (#909, #910, #911).
 *
 * Each builder exposes a small chain of setters and a terminal `build()` that
 * returns a `SorokitResult<Transaction>` rather than throwing. They are built on
 * the same source-account, memo, fee and sequence helpers used by `compose()`,
 * so an explicit `sequenceNumber` makes them fully offline and deterministic.
 *
 * The Stellar SDK `Transaction` object is returned (not an XDR string) so
 * callers can inspect operations or serialise with `.toXDR()` as needed.
 */

import { Asset, Operation, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import type { Transaction } from "@stellar/stellar-sdk";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage } from "../shared";
import { isValidPublicKey } from "../shared/utils";
import { DEFAULT_TX_TIMEOUT_SECONDS } from "../shared/constants";
import type { ResolvedNetworkConfig } from "../shared/types";
import type { MemoParams } from "./types";
import {
  resolveFee,
  resolveMemo,
  resolveSourceAccount,
  updateSequenceCache,
} from "./buildHelpers";
import { validateBumpSequenceValue } from "./bumpSequence";
import {
  validateClawbackAmount,
  validateClawbackAssetCode,
} from "./buildTransaction";

/** Options shared by all three single-operation builders. */
export interface TransactionBuilderOptions extends MemoParams {
  /**
   * Pre-fetched sequence number for the source account. When supplied, no
   * Horizon `loadAccount` call is made and the transaction is built offline.
   * For `BumpSequenceBuilder` this also supplies the "current sequence" used
   * by the `bumpTo > current` validation.
   */
  sequenceNumber?: string;
  /** When true, reuse the shared five-second sequence cache. */
  autoFetchSequence?: boolean;
  /** Fee in stroops. Defaults to the network base fee. */
  estimatedFee?: string;
  /** Transaction timeout in seconds. Defaults to 30. */
  timeout?: number;
}

interface BuilderContext {
  sourcePublicKey: string;
  networkConfig: ResolvedNetworkConfig;
  options: TransactionBuilderOptions;
}

type SequenceInput = string | bigint | number;

/** Normalise a caller-supplied sequence to the string form the SDK expects. */
function normalizeSequence(value: SequenceInput): string | null {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? value.toString() : null;
  }
  if (typeof value === "string") return value.trim();
  return null;
}

/** Resolve the source account and assemble a one-operation transaction. */
async function finalizeBuild(
  context: BuilderContext,
  operation: xdr.Operation,
): Promise<SorokitResult<Transaction>> {
  const sourceResult = await resolveSourceAccount(
    context.networkConfig.horizonUrl,
    context.sourcePublicKey,
    context.options.sequenceNumber,
    context.options.autoFetchSequence,
  );
  if (sourceResult.status === "error") return sourceResult;
  const sourceAccount = sourceResult.data;

  const memoResult = resolveMemo(context.options);
  if (memoResult.status === "error") return memoResult;

  try {
    const builder = new TransactionBuilder(sourceAccount, {
      fee: resolveFee(context.options.estimatedFee),
      networkPassphrase: context.networkConfig.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(context.options.timeout ?? DEFAULT_TX_TIMEOUT_SECONDS);

    if (memoResult.data) {
      builder.addMemo(memoResult.data);
    }

    const transaction = builder.build();

    if (
      context.options.autoFetchSequence === true &&
      context.options.sequenceNumber === undefined
    ) {
      updateSequenceCache(context.sourcePublicKey, sourceAccount.sequenceNumber());
    }

    return ok(transaction);
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Failed to build transaction: ${toMessage(cause)}`,
      cause,
    );
  }
}

/**
 * Build an `ACCOUNT_MERGE` operation that transfers the entire balance of the
 * source account to a destination and removes the source from the ledger.
 *
 * ⚠ **DATA LOSS:** account merge is irreversible. The source account is
 * deleted, along with its signers, trustlines, offers and data entries. Only
 * its native XLM balance is transferred; assets held in trustlines must be
 * moved out beforehand or they are lost. Never merge an account you may need
 * to recover.
 *
 * The destination is validated as a well-formed Stellar G-address and must not
 * be the source itself. This builder deliberately does not check whether the
 * destination exists on the ledger (#911 Out of Scope).
 *
 * @example
 * const result = await new AccountMergeBuilder(source, networkConfig)
 *   .destination(destination)
 *   .build();
 */
export class AccountMergeBuilder {
  private _destination?: string;

  constructor(
    private readonly sourcePublicKey: string,
    private readonly networkConfig: ResolvedNetworkConfig,
    private readonly options: TransactionBuilderOptions = {},
  ) {}

  /** Set the account that will receive the source account's XLM balance. */
  destination(publicKey: string): this {
    this._destination = publicKey;
    return this;
  }

  /** Validate the destination and build the unsigned transaction. */
  async build(): Promise<SorokitResult<Transaction>> {
    if (
      typeof this._destination !== "string" ||
      !isValidPublicKey(this._destination)
    ) {
      return err(
        SorokitErrorCode.INVALID_ADDRESS,
        `Account merge destination must be a valid Stellar G-address, got: "${String(this._destination)}".`,
      );
    }

    if (this._destination === this.sourcePublicKey) {
      return err(
        SorokitErrorCode.VALIDATION,
        "Account merge destination must not be the source account: merging an account into itself is not allowed.",
      );
    }

    return finalizeBuild(
      this.context(),
      Operation.accountMerge({ destination: this._destination }),
    );
  }

  private context(): BuilderContext {
    return {
      sourcePublicKey: this.sourcePublicKey,
      networkConfig: this.networkConfig,
      options: this.options,
    };
  }
}

/**
 * Build a `BUMP_SEQUENCE` operation that moves the source account's sequence
 * number forward, invalidating every transaction signed with an older
 * sequence. This is the standard way to cancel pending (pre-authorized)
 * transactions that have not yet been submitted.
 *
 * The target must be a stringified unsigned 64-bit integer and, when the
 * caller supplies `sequenceNumber`, strictly greater than the current
 * sequence. This builder never fetches the current sequence from Horizon
 * (#910 Out of Scope); supply it through `options.sequenceNumber` to enable
 * the comparison, or use the offline `resolveSourceAccount` path.
 *
 * @example
 * // Cancel every pending transaction whose sequence is below 1000.
 * const result = await new BumpSequenceBuilder(source, networkConfig, {
 *   sequenceNumber: "999",
 * })
 *   .bumpTo(1000n)
 *   .build();
 */
export class BumpSequenceBuilder {
  private bumpToValue?: SequenceInput;

  constructor(
    private readonly sourcePublicKey: string,
    private readonly networkConfig: ResolvedNetworkConfig,
    private readonly options: TransactionBuilderOptions = {},
  ) {}

  /** Set the new sequence number to bump to. */
  bumpTo(sequence: SequenceInput): this {
    this.bumpToValue = sequence;
    return this;
  }

  /** Validate the target sequence and build the unsigned transaction. */
  async build(): Promise<SorokitResult<Transaction>> {
    if (this.bumpToValue === undefined) {
      return err(
        SorokitErrorCode.VALIDATION,
        "A bump-to sequence is required. Call .bumpTo(sequence) before .build().",
      );
    }

    const bumpTo = normalizeSequence(this.bumpToValue);
    if (bumpTo === null) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        "Bump-to sequence must be a string, bigint, or safe integer.",
      );
    }

    const valueResult = validateBumpSequenceValue(bumpTo);
    if (valueResult.status === "error") return valueResult;

    const current = this.options.sequenceNumber;
    if (current !== undefined) {
      const currentResult = validateBumpSequenceValue(current);
      if (currentResult.status === "error") return currentResult;

      if (BigInt(bumpTo) <= BigInt(current)) {
        return err(
          SorokitErrorCode.VALIDATION,
          `Bump-to sequence "${bumpTo}" must be greater than the current sequence "${current}".`,
        );
      }
    }

    return finalizeBuild(
      this.context(),
      Operation.bumpSequence({ bumpTo }),
    );
  }

  private context(): BuilderContext {
    return {
      sourcePublicKey: this.sourcePublicKey,
      networkConfig: this.networkConfig,
      options: this.options,
    };
  }
}

/** An issued asset supplied to `ClawbackBuilder.asset()`. */
export interface ClawbackAssetInput {
  assetCode: string;
  assetIssuer: string;
}

/**
 * Build a `CLAWBACK` operation with which an issuer reclaims tokens from a
 * token holder, for example to reverse a mis-sent payment or satisfy a
 * compliance action.
 *
 * The asset must be issued (native XLM is rejected) and the amount must be a
 * positive decimal string with at most seven decimal places. This builder
 * validates the *structure* of the asset and issuer, but does not query the
 * ledger to confirm the issuer's clawback flag is enabled (#909 Out of Scope).
 *
 * @example
 * const result = await new ClawbackBuilder(issuer, networkConfig)
 *   .asset({ assetCode: "USDC", assetIssuer: issuer })
 *   .from(holder)
 *   .amount("25.5")
 *   .build();
 */
export class ClawbackBuilder {
  private assetCode?: string;
  private assetIssuer?: string;
  private fromAddress?: string;
  private clawbackAmount?: string;

  constructor(
    private readonly sourcePublicKey: string,
    private readonly networkConfig: ResolvedNetworkConfig,
    private readonly options: TransactionBuilderOptions = {},
  ) {}

  /** Set the issued asset to reclaim. Native XLM is not supported. */
  asset(asset: Asset | ClawbackAssetInput): this {
    if (asset instanceof Asset) {
      this.assetCode = asset.getCode();
      this.assetIssuer = asset.getIssuer();
    } else {
      this.assetCode = asset?.assetCode;
      this.assetIssuer = asset?.assetIssuer;
    }
    return this;
  }

  /** Set the holder account from which the asset is reclaimed. */
  from(publicKey: string): this {
    this.fromAddress = publicKey;
    return this;
  }

  /** Set the positive amount to reclaim, as a decimal string. */
  amount(amount: string): this {
    this.clawbackAmount = amount;
    return this;
  }

  /** Validate the asset, holder and amount, then build the transaction. */
  async build(): Promise<SorokitResult<Transaction>> {
    const codeResult = validateClawbackAssetCode(this.assetCode as string);
    if (codeResult.status === "error") return codeResult;

    if (
      typeof this.assetIssuer !== "string" ||
      !isValidPublicKey(this.assetIssuer)
    ) {
      return err(
        SorokitErrorCode.INVALID_ADDRESS,
        `Clawback asset issuer must be a valid Stellar G-address, got: "${String(this.assetIssuer)}".`,
      );
    }

    if (
      typeof this.fromAddress !== "string" ||
      !isValidPublicKey(this.fromAddress)
    ) {
      return err(
        SorokitErrorCode.INVALID_ADDRESS,
        `Clawback source holder must be a valid Stellar G-address, got: "${String(this.fromAddress)}".`,
      );
    }

    const amountResult = validateClawbackAmount(this.clawbackAmount as string);
    if (amountResult.status === "error") return amountResult;

    return finalizeBuild(
      this.context(),
      Operation.clawback({
        asset: new Asset(this.assetCode as string, this.assetIssuer),
        from: this.fromAddress,
        amount: this.clawbackAmount as string,
      }),
    );
  }

  private context(): BuilderContext {
    return {
      sourcePublicKey: this.sourcePublicKey,
      networkConfig: this.networkConfig,
      options: this.options,
    };
  }
}
