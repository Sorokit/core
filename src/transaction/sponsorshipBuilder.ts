/**
 * Transaction sponsorship builder (#974).
 *
 * Wraps operations in a `beginSponsoringFutureReserves` /
 * `endSponsoringFutureReserves` pair so that a sponsor account pays the
 * reserves for what those operations create (accounts, trustlines, offers,
 * data entries, ...) on behalf of another account.
 *
 * Requirements:
 * - The sponsor must be a valid `G...` account that exists on the network and
 *   holds enough XLM to cover the sponsored reserves.
 * - The sponsor and the sponsored account must both sign the final
 *   transaction (the sponsor authorises `begin`, the sponsored account
 *   authorises `end`). Any signatures on the original transaction are dropped,
 *   because wrapping changes its contents; sign the returned transaction again.
 * - The sponsor must differ from the sponsored account.
 * - Soroban operations (`invokeHostFunction`, `extendFootprintTtl`,
 *   `restoreFootprint`) cannot be combined with other operations, so they
 *   cannot be wrapped.
 *
 * This builds the transaction only; collecting the sponsor's approval is out of
 * scope. To have an account pay only the *network fee* of an existing signed
 * transaction, use `buildFeeBumpTransaction`.
 */

import {
  Account,
  MuxedAccount,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { isValidPublicKey } from "../shared/utils";
import { toMessage } from "../shared";

const SOROBAN_OPERATION_TYPES = new Set<string>([
  "invokeHostFunction",
  "extendFootprintTtl",
  "restoreFootprint",
]);

function operationAddress(op: xdr.Operation): string | undefined {
  const source = op.sourceAccount();
  if (!source) return undefined;
  const type = source.switch().name;
  if (type === "keyTypeEd25519") {
    return StrKey.encodeEd25519PublicKey(source.ed25519());
  }
  // Muxed source: the sponsored account is its underlying G... account.
  return StrKey.encodeEd25519PublicKey(source.med25519().ed25519());
}

function wrapOperations(
  operations: xdr.Operation[],
  sponsorKey: string,
  sponsoredKey: string,
): xdr.Operation[] {
  return [
    Operation.beginSponsoringFutureReserves({
      sponsoredId: sponsoredKey,
      source: sponsorKey,
    }),
    ...operations,
    Operation.endSponsoringFutureReserves({ source: sponsoredKey }),
  ];
}

function envelopeOperations(tx: Transaction): xdr.Operation[] {
  const envelope = tx.toEnvelope();
  return envelope.switch().name === "envelopeTypeTxV0"
    ? envelope.v0().tx().operations()
    : envelope.v1().tx().operations();
}

function isUsableOperation(op: xdr.Operation): boolean {
  return !SOROBAN_OPERATION_TYPES.has(op.body().switch().name);
}

/**
 * Sponsor the reserves of every operation in a transaction.
 *
 * Returns a new transaction (same source, memo, time/ledger bounds and
 * per-operation fee) whose operations are wrapped in a sponsorship pair with
 * `sponsorKey` as sponsor and the transaction source as the sponsored account.
 * The result is unsigned; the sponsor and the source must both sign it.
 *
 * @param tx         - Transaction to sponsor.
 * @param sponsorKey - `G...` address of the account paying the reserves.
 * @returns `ok(Transaction)`; `INVALID_ADDRESS` for a bad or identical sponsor,
 *          `INVALID_TRANSACTION` for an unsupported transaction,
 *          `TX_BUILD_FAILED` if the SDK rejects the rebuilt transaction.
 *
 * @example
 * const sponsored = sponsorTransaction(tx, "GSPONSOR...");
 * if (sponsored.status === "ok") {
 *   // sign with the sponsor and the original source, then submit
 * }
 */
export function sponsorTransaction(
  tx: Transaction,
  sponsorKey: string,
): SorokitResult<Transaction> {
  if (!sponsorKey || !isValidPublicKey(sponsorKey)) {
    return err(
      SorokitErrorCode.INVALID_ADDRESS,
      `Invalid sponsor address: ${sponsorKey}`,
    );
  }
  if (!(tx instanceof Transaction)) {
    return err(
      SorokitErrorCode.INVALID_TRANSACTION,
      "sponsorTransaction expects a Transaction (fee-bump transactions are not supported)",
    );
  }

  try {
    const baseSource = tx.source.startsWith("M")
      ? MuxedAccount.fromAddress(tx.source, "0").baseAccount().accountId()
      : tx.source;
    if (baseSource === sponsorKey) {
      return err(
        SorokitErrorCode.INVALID_ADDRESS,
        "Sponsor must differ from the transaction source account",
      );
    }

    const operations = envelopeOperations(tx);
    if (operations.length === 0) {
      return err(
        SorokitErrorCode.INVALID_TRANSACTION,
        "Cannot sponsor a transaction with no operations",
      );
    }
    if (!operations.every(isUsableOperation)) {
      return err(
        SorokitErrorCode.INVALID_TRANSACTION,
        "Soroban operations cannot be wrapped in a sponsorship",
      );
    }

    // The builder bumps the sequence number itself, so start one below.
    const sequence = (BigInt(tx.sequence) - 1n).toString();
    const source = tx.source.startsWith("M")
      ? MuxedAccount.fromAddress(tx.source, sequence)
      : new Account(tx.source, sequence);

    // Keep the per-operation fee; the total grows with the two added operations.
    const perOperationFee = Math.max(
      Math.floor(Number(tx.fee) / tx.operations.length),
      100,
    );

    const builder = new TransactionBuilder(source, {
      fee: String(perOperationFee),
      networkPassphrase: tx.networkPassphrase,
      memo: tx.memo,
      ...(tx.timeBounds ? { timebounds: tx.timeBounds } : {}),
      ...(tx.ledgerBounds ? { ledgerbounds: tx.ledgerBounds } : {}),
    });
    if (!tx.timeBounds) builder.setTimeout(0);

    for (const op of wrapOperations(operations, sponsorKey, baseSource)) {
      builder.addOperation(op);
    }
    return ok(builder.build());
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Failed to build sponsored transaction: ${toMessage(cause)}`,
      cause,
    );
  }
}

/**
 * Sponsor the reserves of a single operation.
 *
 * Returns `[beginSponsoring, op, endSponsoring]`, ready to be added to a
 * transaction in order. The sponsored account is `sponsoredKey` when given,
 * otherwise the operation's own source account.
 *
 * @param op          - Operation to sponsor.
 * @param sponsorKey  - `G...` address of the account paying the reserves.
 * @param sponsoredKey - `G...` address of the sponsored account. Required when
 *                       `op` has no source account of its own.
 * @returns `ok(xdr.Operation[])`; `INVALID_ADDRESS` for a bad or identical
 *          sponsor or an unresolvable sponsored account, `INVALID_TRANSACTION`
 *          for a Soroban operation.
 *
 * @example
 * const op = Operation.changeTrust({ asset, source: "GUSER..." });
 * const wrapped = sponsorOperation(op, "GSPONSOR...");
 * if (wrapped.status === "ok") wrapped.data.forEach((o) => builder.addOperation(o));
 */
export function sponsorOperation(
  op: xdr.Operation,
  sponsorKey: string,
  sponsoredKey?: string,
): SorokitResult<xdr.Operation[]> {
  if (!sponsorKey || !isValidPublicKey(sponsorKey)) {
    return err(
      SorokitErrorCode.INVALID_ADDRESS,
      `Invalid sponsor address: ${sponsorKey}`,
    );
  }
  try {
    if (!isUsableOperation(op)) {
      return err(
        SorokitErrorCode.INVALID_TRANSACTION,
        "Soroban operations cannot be wrapped in a sponsorship",
      );
    }
    const sponsored = sponsoredKey ?? operationAddress(op);
    if (!sponsored || !isValidPublicKey(sponsored)) {
      return err(
        SorokitErrorCode.INVALID_ADDRESS,
        sponsored
          ? `Invalid sponsored address: ${sponsored}`
          : "Cannot determine the sponsored account: pass sponsoredKey or give the operation a source",
      );
    }
    if (sponsored === sponsorKey) {
      return err(
        SorokitErrorCode.INVALID_ADDRESS,
        "Sponsor must differ from the sponsored account",
      );
    }
    return ok(wrapOperations([op], sponsorKey, sponsored));
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Failed to build sponsored operation: ${toMessage(cause)}`,
      cause,
    );
  }
}
