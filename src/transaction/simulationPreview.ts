/**
 * Transaction Simulation and Safe Execution Preview (#612)
 *
 * Projects what a transaction will do before it is submitted: which balances
 * change, by how much, and what new ledger state (trustlines, etc.) gets
 * created — so an app can show the user "Will send 100 XLM to G...", "Fee:
 * 500 stroops", "New balance: 900 XLM" before they sign anything.
 *
 * Classic Stellar operations (payment, createAccount, path payments,
 * changeTrust) have no server-side "dry run": Horizon only accepts fully
 * signed, submittable transactions. This module instead parses the
 * transaction's operations (the same approach `validateTransaction.ts`
 * uses) and computes each source account's projected balance deltas
 * algebraically against its current on-ledger balances.
 *
 * `invokeHostFunction` (Soroban) operations delegate to the existing
 * `soroban.simulateTransaction`, which IS a real RPC-side dry run — this
 * module does not attempt to re-derive contract effects itself.
 */

import { TransactionBuilder, FeeBumpTransaction, Asset } from "@stellar/stellar-sdk";
import type { Transaction, Operation } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage } from "../shared/errors";
import { getAccount } from "../account/getAccount";
import type { AssetBalance } from "../account/types";
import { simulateTransaction } from "../soroban/simulateTransaction";
import type { SimulateTransactionResult } from "../soroban/types";

// ─── Types ────────────────────────────────────────────────────────────────────

/** A canonical asset identifier used within a preview: "XLM" or "CODE:ISSUER". */
export interface PreviewAsset {
  code: string;
  issuer: string | null;
}

/** Projected change to a single account's balance of a single asset. */
export interface BalanceEffect {
  /** The account whose balance changes. */
  account: string;
  asset: PreviewAsset;
  /** Balance before the transaction, or `null` when the account/trustline doesn't exist yet. */
  before: string | null;
  /** Projected balance after the transaction, as an exact decimal string. */
  after: string;
  /** Signed delta (`after - before`), as an exact decimal string. */
  delta: string;
}

/** A non-balance state change the transaction would cause (e.g. a new trustline). */
export interface StateChange {
  type: "trustline_created" | "trustline_limit_changed" | "account_created";
  description: string;
}

/** Human-readable summary line, e.g. "Will send 100 XLM to GABC...". */
export type PreviewSummaryLine = string;

export interface TransactionPreview {
  /** Transaction fee in stroops, as charged (num operations * base fee for classic tx). */
  fee: string;
  /** Every projected balance change, one entry per (account, asset) pair touched. */
  effects: BalanceEffect[];
  /** Non-balance state changes (new trustlines, new accounts). */
  stateChanges: StateChange[];
  /** Convenience: the source account's projected new XLM balance, when computable. */
  newBalance: string | null;
  /** Human-readable one-line-per-effect summary, e.g. ["Will send 100 XLM to GABC...", "Fee: 500 stroops"]. */
  summary: PreviewSummaryLine[];
  /**
   * Present only when the transaction contains a Soroban `invokeHostFunction`
   * operation — the underlying RPC simulation result for that operation.
   * Classic-only transactions omit this field entirely.
   */
  sorobanSimulation?: SimulateTransactionResult;
}

export interface PreviewTransactionOptions {
  /** Soroban RPC URL — required only when the transaction contains an invokeHostFunction operation. */
  rpcUrl?: string;
  signal?: AbortSignal | undefined;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toPreviewAsset(asset: Asset): PreviewAsset {
  return asset.isNative() ? { code: "XLM", issuer: null } : { code: asset.getCode(), issuer: asset.getIssuer() };
}

function assetKey(asset: PreviewAsset): string {
  return asset.issuer === null ? "XLM" : `${asset.code}:${asset.issuer}`;
}

function formatAssetLabel(asset: PreviewAsset): string {
  return asset.code;
}

function isFeeBumpTransaction(tx: Transaction | FeeBumpTransaction): tx is FeeBumpTransaction {
  return "innerTransaction" in tx;
}

function findBalance(balances: AssetBalance[], asset: PreviewAsset): AssetBalance | undefined {
  if (asset.issuer === null) {
    return balances.find((b) => b.assetType === "native");
  }
  return balances.find((b) => b.assetCode === asset.code && b.assetIssuer === asset.issuer);
}

/** Accumulates signed deltas per (account, asset) so multiple operations against the same balance net out. */
class EffectAccumulator {
  private deltas = new Map<string, { account: string; asset: PreviewAsset; delta: number }>();

  add(account: string, asset: PreviewAsset, delta: number): void {
    const key = `${account}|${assetKey(asset)}`;
    const existing = this.deltas.get(key);
    if (existing) {
      existing.delta += delta;
    } else {
      this.deltas.set(key, { account, asset, delta });
    }
  }

  entries(): { account: string; asset: PreviewAsset; delta: number }[] {
    return Array.from(this.deltas.values());
  }
}

/**
 * Extract balance deltas and state changes from a single classic operation.
 * `sourceAccount` is the operation's own `source`, falling back to the
 * transaction's source account.
 */
function applyOperation(
  op: Operation,
  txSourceAccount: string,
  accumulator: EffectAccumulator,
  stateChanges: StateChange[],
): void {
  const opSource = "source" in op && typeof op.source === "string" ? op.source : txSourceAccount;

  switch (op.type) {
    case "payment": {
      const asset = toPreviewAsset(op.asset);
      const amount = Number(op.amount);
      accumulator.add(opSource, asset, -amount);
      accumulator.add(op.destination, asset, amount);
      break;
    }
    case "createAccount": {
      const asset: PreviewAsset = { code: "XLM", issuer: null };
      const amount = Number(op.startingBalance);
      accumulator.add(opSource, asset, -amount);
      accumulator.add(op.destination, asset, amount);
      stateChanges.push({
        type: "account_created",
        description: `Account ${op.destination} will be created with a starting balance of ${op.startingBalance} XLM.`,
      });
      break;
    }
    case "pathPaymentStrictSend": {
      const sendAsset = toPreviewAsset(op.sendAsset);
      const destAsset = toPreviewAsset(op.destAsset);
      accumulator.add(opSource, sendAsset, -Number(op.sendAmount));
      // destMin is the worst-case receive amount; the actual amount depends on
      // path execution at submission time and cannot be known exactly here.
      accumulator.add(op.destination, destAsset, Number(op.destMin));
      break;
    }
    case "pathPaymentStrictReceive": {
      const sendAsset = toPreviewAsset(op.sendAsset);
      const destAsset = toPreviewAsset(op.destAsset);
      // sendMax is the worst-case send amount; the actual amount depends on
      // path execution at submission time and cannot be known exactly here.
      accumulator.add(opSource, sendAsset, -Number(op.sendMax));
      accumulator.add(op.destination, destAsset, Number(op.destAmount));
      break;
    }
    case "changeTrust": {
      if (!(op.line instanceof Asset)) break;
      const asset = toPreviewAsset(op.line);
      const limit = op.limit ?? "";
      stateChanges.push(
        limit === "0"
          ? {
              type: "trustline_limit_changed",
              description: `Trustline for ${asset.code} on ${opSource} will be removed.`,
            }
          : {
              type: "trustline_created",
              description: `Trustline for ${asset.code} on ${opSource} will be created or updated (limit: ${limit || "max"}).`,
            },
      );
      break;
    }
    default:
      break;
  }
}

function buildSummary(
  effects: BalanceEffect[],
  stateChanges: StateChange[],
  fee: string,
  paymentDescriptions: string[],
): PreviewSummaryLine[] {
  const lines: PreviewSummaryLine[] = [...paymentDescriptions];
  for (const change of stateChanges) {
    lines.push(change.description);
  }
  lines.push(`Fee: ${fee} stroops`);
  for (const effect of effects) {
    lines.push(
      `New balance for ${effect.account} (${formatAssetLabel(effect.asset)}): ${effect.after}`,
    );
  }
  return lines;
}

// ─── Implementation ───────────────────────────────────────────────────────────

/**
 * Preview what a transaction will do before submitting it: projected balance
 * changes, fee, and other ledger state changes (new trustlines/accounts).
 *
 * Works on an unsigned (or signed) transaction XDR — signatures are not
 * required or checked, since nothing is submitted.
 *
 * @param horizonUrl        - Base URL of the Horizon server, used to fetch current balances.
 * @param networkPassphrase - Network passphrase used to parse the transaction XDR.
 * @param transactionXdr    - The transaction envelope XDR to preview.
 * @param options           - `rpcUrl` is required when the transaction contains an invokeHostFunction operation.
 *
 * @example
 * const preview = await previewTransaction(horizonUrl, networkPassphrase, unsignedXdr);
 * if (preview.status === "ok") {
 *   console.log(preview.data.summary.join("\n"));
 *   console.log("New balance:", preview.data.newBalance);
 * }
 */
export async function previewTransaction(
  horizonUrl: string,
  networkPassphrase: string,
  transactionXdr: string,
  options?: PreviewTransactionOptions,
): Promise<SorokitResult<TransactionPreview>> {
  let transaction: Transaction;
  try {
    const parsed = TransactionBuilder.fromXDR(transactionXdr, networkPassphrase);
    transaction = isFeeBumpTransaction(parsed) ? (parsed.innerTransaction as Transaction) : (parsed as Transaction);
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Transaction preview failed because the transaction XDR is malformed: ${toMessage(cause)}`,
      cause,
    );
  }

  const txSourceAccount = transaction.source;
  const accumulator = new EffectAccumulator();
  const stateChanges: StateChange[] = [];
  const paymentDescriptions: string[] = [];

  let sorobanSimulation: SimulateTransactionResult | undefined;

  for (const op of transaction.operations) {
    if (op.type === "invokeHostFunction") {
      if (!options?.rpcUrl) {
        return err(
          SorokitErrorCode.VALIDATION,
          "Transaction preview failed: this transaction contains a Soroban invokeHostFunction " +
            "operation, which requires options.rpcUrl to simulate.",
        );
      }
      const simResult = await simulateTransaction(options.rpcUrl, networkPassphrase, transactionXdr);
      if (simResult.status === "error") return simResult;
      sorobanSimulation = simResult.data;
      continue;
    }

    applyOperation(op, txSourceAccount, accumulator, stateChanges);

    if (op.type === "payment") {
      const asset = toPreviewAsset(op.asset);
      paymentDescriptions.push(
        `Will send ${op.amount} ${formatAssetLabel(asset)} to ${op.destination}.`,
      );
    }
  }

  // Resolve current balances for every distinct account touched, in parallel.
  const accountsTouched = Array.from(new Set(accumulator.entries().map((e) => e.account)));
  const balanceLookups = new Map<string, AssetBalance[]>();
  await Promise.all(
    accountsTouched.map(async (account) => {
      const result = await getAccount(horizonUrl, account, { signal: options?.signal });
      if (result.status === "ok") {
        balanceLookups.set(account, result.data.balances);
      }
      // An account that doesn't exist yet (e.g. the destination of a
      // createAccount op) has no current balances — `before: null` reflects that.
    }),
  );

  const effects: BalanceEffect[] = accumulator.entries().map(({ account, asset, delta }) => {
    const balances = balanceLookups.get(account) ?? [];
    const existing = findBalance(balances, asset);
    const before = existing ? existing.balance : null;
    const beforeNumeric = before !== null ? Number(before) : 0;
    const after = beforeNumeric + delta;
    return {
      account,
      asset,
      before,
      after: after.toFixed(7),
      delta: (delta >= 0 ? "+" : "") + delta.toFixed(7),
    };
  });

  const feeStroops = String(transaction.fee);
  const newBalanceEffect = effects.find(
    (e) => e.account === txSourceAccount && e.asset.issuer === null,
  );
  const newBalance = newBalanceEffect ? newBalanceEffect.after : null;

  const summary = buildSummary(effects, stateChanges, feeStroops, paymentDescriptions);

  return ok({
    fee: feeStroops,
    effects,
    stateChanges,
    newBalance,
    summary,
    ...(sorobanSimulation ? { sorobanSimulation } : {}),
  });
}
