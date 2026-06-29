import { TransactionBuilder, StrKey } from "@stellar/stellar-sdk";
import { ok } from "../shared/response";
import type { SorokitResult } from "../shared/response";

export type FindingSeverity = "error" | "warning" | "info";

export interface TransactionValidationFinding {
  severity: FindingSeverity;
  code: string;
  message: string;
  operationIndex?: number;
}

export interface TransactionValidationReport {
  valid: boolean;
  findings: TransactionValidationFinding[];
  warnings: TransactionValidationFinding[];
  errors: TransactionValidationFinding[];
  operationCount: number;
  fee: string | null;
}

export interface ValidationRules {
  /** Network passphrase used to decode the XDR. Required. */
  networkPassphrase: string;
  /** Maximum acceptable fee per operation in stroops. Default: 1_000_000 (0.1 XLM). */
  maxFeePerOpStroops?: number;
  /** Minimum acceptable fee in stroops. Default: 100. */
  minFeeStroops?: number;
  /** Disallowed operation types. */
  disallowedOperationTypes?: string[];
  /** Custom validator invoked per operation. */
  customOperationValidator?: (
    op: { type: string; [key: string]: unknown },
    index: number,
  ) => TransactionValidationFinding[] | null;
}

export const DEFAULT_VALIDATION_RULES: Required<
  Pick<ValidationRules, "maxFeePerOpStroops" | "minFeeStroops">
> = {
  maxFeePerOpStroops: 1_000_000,
  minFeeStroops: 100,
};

function isValidStellarAddress(addr: unknown): addr is string {
  if (typeof addr !== "string") return false;
  return StrKey.isValidEd25519PublicKey(addr) || StrKey.isValidMed25519PublicKey(addr);
}

function isPositiveAmount(amount: unknown): boolean {
  if (typeof amount !== "string") return false;
  const n = Number(amount);
  return Number.isFinite(n) && n > 0;
}

/**
 * Comprehensively validate a transaction XDR before submission.
 *
 * Performs:
 * - XDR parse
 * - operation type allow/deny list
 * - amount positivity
 * - receiver address format
 * - fee sanity (min/max)
 * - optional custom rules
 *
 * Never throws — every problem surfaces as a finding.
 */
export function validateTransactionXdr(
  xdr: string,
  rules: ValidationRules,
): SorokitResult<TransactionValidationReport> {
  const findings: TransactionValidationFinding[] = [];
  const maxFeePerOp = rules.maxFeePerOpStroops ?? DEFAULT_VALIDATION_RULES.maxFeePerOpStroops;
  const minFee = rules.minFeeStroops ?? DEFAULT_VALIDATION_RULES.minFeeStroops;

  let tx: ReturnType<typeof TransactionBuilder.fromXDR>;
  try {
    tx = TransactionBuilder.fromXDR(xdr, rules.networkPassphrase);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    findings.push({
      severity: "error",
      code: "XDR_INVALID",
      message: `XDR could not be parsed: ${message}`,
    });
    return ok({
      valid: false,
      findings,
      warnings: [],
      errors: findings,
      operationCount: 0,
      fee: null,
    });
  }

  const operations: ReadonlyArray<{ type: string; [key: string]: unknown }> =
    "operations" in tx ? (tx.operations as never) : [];
  const fee = "fee" in tx ? String((tx as { fee: string | number }).fee) : null;

  if (fee !== null) {
    const feeNum = Number(fee);
    if (!Number.isFinite(feeNum) || feeNum < minFee) {
      findings.push({
        severity: "error",
        code: "FEE_TOO_LOW",
        message: `Fee ${fee} stroops is below minimum ${minFee}.`,
      });
    } else if (operations.length > 0 && feeNum / operations.length > maxFeePerOp) {
      findings.push({
        severity: "warning",
        code: "FEE_TOO_HIGH",
        message: `Fee ${fee} stroops exceeds ${maxFeePerOp} per operation (${operations.length} ops).`,
      });
    }
  }

  if (operations.length === 0) {
    findings.push({
      severity: "error",
      code: "NO_OPERATIONS",
      message: "Transaction contains no operations.",
    });
  }

  const disallowed = new Set(rules.disallowedOperationTypes ?? []);

  operations.forEach((op, index) => {
    if (disallowed.has(op.type)) {
      findings.push({
        severity: "error",
        code: "OPERATION_DISALLOWED",
        message: `Operation type ${op.type} is disallowed by rules.`,
        operationIndex: index,
      });
    }

    if ("amount" in op && op.amount !== undefined) {
      if (!isPositiveAmount(op.amount)) {
        findings.push({
          severity: "error",
          code: "AMOUNT_INVALID",
          message: `Operation amount must be a positive numeric string (got ${String(op.amount)}).`,
          operationIndex: index,
        });
      }
    }

    if ("startingBalance" in op && op.startingBalance !== undefined) {
      if (!isPositiveAmount(op.startingBalance)) {
        findings.push({
          severity: "error",
          code: "AMOUNT_INVALID",
          message: `Starting balance must be a positive numeric string.`,
          operationIndex: index,
        });
      }
    }

    if ("destination" in op && op.destination !== undefined) {
      if (!isValidStellarAddress(op.destination)) {
        findings.push({
          severity: "error",
          code: "RECEIVER_INVALID",
          message: `Destination ${String(op.destination)} is not a valid Stellar address.`,
          operationIndex: index,
        });
      }
    }

    const custom = rules.customOperationValidator?.(op, index);
    if (custom && custom.length > 0) findings.push(...custom);
  });

  const errors = findings.filter((f) => f.severity === "error");
  const warnings = findings.filter((f) => f.severity === "warning");

  return ok({
    valid: errors.length === 0,
    findings,
    warnings,
    errors,
    operationCount: operations.length,
    fee,
  });
}
