/**
 * Transaction Comparator — Diff Two Transactions (#1003)
 *
 * Compares two transactions (before/after optimization or signing),
 * diffs operations, fees, memos, sequence numbers, and signatures,
 * and formats actionable diff outputs.
 */

import { TransactionBuilder, Transaction, FeeBumpTransaction, Networks } from "@stellar/stellar-sdk";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

export interface OperationDiff {
  index: number;
  type1?: string | undefined;
  type2?: string | undefined;
  changedProperties: Record<string, { tx1: unknown; tx2: unknown }>;
}

export interface TransactionSummary {
  sourceAccount: string;
  fee: string | number;
  sequenceNumber?: string | undefined;
  memoType?: string | undefined;
  memoValue?: string | undefined;
  operationsCount: number;
  operations: Array<{ type: string; [key: string]: unknown }>;
  signaturesCount: number;
  timeBounds?: { minTime?: string | undefined; maxTime?: string | undefined } | undefined;
}

export interface ComparisonResult {
  identical: boolean;
  differences: {
    sourceAccount?: { tx1: string; tx2: string } | undefined;
    fee?: { tx1: string | number; tx2: string | number; delta: number } | undefined;
    sequenceNumber?: { tx1?: string | undefined; tx2?: string | undefined } | undefined;
    memo?: { tx1?: string | undefined; tx2?: string | undefined } | undefined;
    operationsCount?: { tx1: number; tx2: number } | undefined;
    operations?: OperationDiff[] | undefined;
    signaturesCount?: { tx1: number; tx2: number } | undefined;
    timeBounds?: { tx1?: unknown; tx2?: unknown } | undefined;
  };
  changesSummary: string[];
}

function parseTx(tx: unknown): TransactionSummary {
  if (typeof tx === "string") {
    try {
      const parsed = TransactionBuilder.fromXDR(tx, Networks.TESTNET);
      return parseTxInstance(parsed);
    } catch {
      return {
        sourceAccount: "unknown",
        fee: 0,
        operationsCount: 0,
        operations: [],
        signaturesCount: 0,
      };
    }
  }

  if (tx && (tx instanceof Transaction || tx instanceof FeeBumpTransaction)) {
    return parseTxInstance(tx);
  }

  if (tx && typeof tx === "object") {
    const obj = tx as Record<string, unknown>;
    const ops = Array.isArray(obj.operations) ? obj.operations : [];
    const seq = obj.sequenceNumber ? String(obj.sequenceNumber) : (obj.sequence ? String(obj.sequence) : undefined);
    const mType = obj.memoType ? String(obj.memoType) : undefined;
    const mVal = obj.memoValue !== undefined ? String(obj.memoValue) : (obj.memo !== undefined ? String(obj.memo) : undefined);

    const res: TransactionSummary = {
      sourceAccount: String(obj.sourceAccount ?? obj.source ?? ""),
      fee: (obj.fee as string | number) ?? 0,
      operationsCount: ops.length,
      operations: ops as Array<{ type: string; [key: string]: unknown }>,
      signaturesCount: Array.isArray(obj.signatures) ? obj.signatures.length : 0,
    };
    if (seq !== undefined) res.sequenceNumber = seq;
    if (mType !== undefined) res.memoType = mType;
    if (mVal !== undefined) res.memoValue = mVal;
    if (obj.timeBounds) {
      res.timeBounds = obj.timeBounds as { minTime?: string | undefined; maxTime?: string | undefined };
    }
    return res;
  }

  throw new Error("Invalid transaction input for comparison");
}

function parseTxInstance(tx: Transaction | FeeBumpTransaction): TransactionSummary {
  if (tx instanceof FeeBumpTransaction) {
    return {
      sourceAccount: tx.feeSource,
      fee: tx.fee,
      operationsCount: tx.innerTransaction.operations.length,
      operations: tx.innerTransaction.operations as unknown as Array<{ type: string }>,
      signaturesCount: tx.signatures.length,
    };
  }

  const memo = tx.memo;
  const res: TransactionSummary = {
    sourceAccount: tx.source,
    fee: tx.fee,
    sequenceNumber: tx.sequence,
    operationsCount: tx.operations.length,
    operations: tx.operations as unknown as Array<{ type: string }>,
    signaturesCount: tx.signatures.length,
  };

  if (memo) {
    if (memo.type) res.memoType = memo.type;
    if (memo.value !== null && memo.value !== undefined) res.memoValue = String(memo.value);
  }

  if (tx.timeBounds) {
    res.timeBounds = {
      ...(tx.timeBounds.minTime !== undefined ? { minTime: tx.timeBounds.minTime } : {}),
      ...(tx.timeBounds.maxTime !== undefined ? { maxTime: tx.timeBounds.maxTime } : {}),
    };
  }

  return res;
}

/**
 * Compare two transactions and return structured diff.
 */
export function compareTxs(tx1Input: unknown, tx2Input: unknown): SorokitResult<ComparisonResult> {
  try {
    if (!tx1Input || !tx2Input) {
      return err(
        SorokitErrorCode.VALIDATION,
        "Two transactions are required for comparison",
      );
    }

    const t1 = parseTx(tx1Input);
    const t2 = parseTx(tx2Input);

    const changesSummary: string[] = [];
    const differences: ComparisonResult["differences"] = {};

    // 1. Source Account
    if (t1.sourceAccount !== t2.sourceAccount) {
      differences.sourceAccount = { tx1: t1.sourceAccount, tx2: t2.sourceAccount };
      changesSummary.push(`Source account changed from ${t1.sourceAccount} to ${t2.sourceAccount}`);
    }

    // 2. Fee
    const fee1Num = Number(t1.fee) || 0;
    const fee2Num = Number(t2.fee) || 0;
    if (fee1Num !== fee2Num) {
      differences.fee = { tx1: t1.fee, tx2: t2.fee, delta: fee2Num - fee1Num };
      changesSummary.push(`Fee changed from ${t1.fee} to ${t2.fee} (delta: ${fee2Num - fee1Num})`);
    }

    // 3. Sequence Number
    if (t1.sequenceNumber !== t2.sequenceNumber) {
      differences.sequenceNumber = {};
      if (t1.sequenceNumber !== undefined) differences.sequenceNumber.tx1 = t1.sequenceNumber;
      if (t2.sequenceNumber !== undefined) differences.sequenceNumber.tx2 = t2.sequenceNumber;
      changesSummary.push(`Sequence number changed from ${t1.sequenceNumber ?? "none"} to ${t2.sequenceNumber ?? "none"}`);
    }

    // 4. Memo
    if (t1.memoValue !== t2.memoValue || t1.memoType !== t2.memoType) {
      const memo1Str = t1.memoValue ? `${t1.memoType ?? "text"}:${t1.memoValue}` : "none";
      const memo2Str = t2.memoValue ? `${t2.memoType ?? "text"}:${t2.memoValue}` : "none";
      differences.memo = {
        tx1: memo1Str,
        tx2: memo2Str,
      };
      changesSummary.push(`Memo changed from ${memo1Str} to ${memo2Str}`);
    }

    // 5. Operations
    if (t1.operationsCount !== t2.operationsCount) {
      differences.operationsCount = { tx1: t1.operationsCount, tx2: t2.operationsCount };
      changesSummary.push(`Operation count changed from ${t1.operationsCount} to ${t2.operationsCount}`);
    }

    const maxOps = Math.max(t1.operations.length, t2.operations.length);
    const opDiffs: OperationDiff[] = [];

    for (let i = 0; i < maxOps; i++) {
      const op1 = t1.operations[i];
      const op2 = t2.operations[i];

      if (!op1 || !op2 || op1.type !== op2.type) {
        const diffItem: OperationDiff = {
          index: i,
          changedProperties: {
            type: { tx1: op1?.type ?? "missing", tx2: op2?.type ?? "missing" },
          },
        };
        if (op1?.type !== undefined) diffItem.type1 = op1.type;
        if (op2?.type !== undefined) diffItem.type2 = op2.type;

        opDiffs.push(diffItem);
        changesSummary.push(`Operation #${i} type changed: ${op1?.type ?? "none"} -> ${op2?.type ?? "none"}`);
      } else {
        const propDiff: Record<string, { tx1: unknown; tx2: unknown }> = {};
        const allKeys = new Set([...Object.keys(op1), ...Object.keys(op2)]);
        for (const k of allKeys) {
          const v1 = (op1 as Record<string, unknown>)[k];
          const v2 = (op2 as Record<string, unknown>)[k];
          if (JSON.stringify(v1) !== JSON.stringify(v2)) {
            propDiff[k] = { tx1: v1, tx2: v2 };
          }
        }
        if (Object.keys(propDiff).length > 0) {
          opDiffs.push({
            index: i,
            type1: op1.type,
            type2: op2.type,
            changedProperties: propDiff,
          });
          changesSummary.push(`Operation #${i} (${op1.type}) modified: ${Object.keys(propDiff).join(", ")}`);
        }
      }
    }

    if (opDiffs.length > 0) {
      differences.operations = opDiffs;
    }

    // 6. Signatures count
    if (t1.signaturesCount !== t2.signaturesCount) {
      differences.signaturesCount = { tx1: t1.signaturesCount, tx2: t2.signaturesCount };
      changesSummary.push(`Signatures count changed from ${t1.signaturesCount} to ${t2.signaturesCount}`);
    }

    const identical = changesSummary.length === 0;

    return ok({
      identical,
      differences,
      changesSummary,
    });
  } catch (cause) {
    return err(
      SorokitErrorCode.VALIDATION,
      cause instanceof Error ? cause.message : "Failed to compare transactions",
      cause,
    );
  }
}
export type TxOperationDiff = OperationDiff;
