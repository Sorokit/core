import {
  Transaction,
  FeeBumpTransaction,
  TransactionBuilder,
  Networks,
  StrKey,
} from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage } from "../shared";

export interface ValidationError {
  field: "sequence" | "fee" | "signers" | "source" | "xdr" | string;
  message: string;
}

export interface ValidationReport {
  valid: boolean;
  errors: ValidationError[];
}

export interface PreflightValidationOptions {
  networkPassphrase?: string;
  minFeePerOp?: number;
}

/**
 * Validates a transaction prior to network submission.
 * Performs comprehensive pre-flight checks:
 * 1. Checks that sequence number is valid (> 0 and valid integer)
 * 2. Checks that fees are sufficient (at least 100 stroops per operation)
 * 3. Checks that at least one signature/signer is present
 * 4. Checks that the source account is a valid Stellar public key
 *
 * @param tx      - Transaction, FeeBumpTransaction, or base64 XDR string.
 * @param options - Optional validation configuration.
 * @returns SorokitResult with a ValidationReport.
 */
export function validateTransaction(
  tx: Transaction | FeeBumpTransaction | string,
  options?: PreflightValidationOptions,
): SorokitResult<ValidationReport> {
  let transaction: Transaction | FeeBumpTransaction;

  if (typeof tx === "string") {
    if (!tx.trim()) {
      return ok({
        valid: false,
        errors: [{ field: "xdr", message: "Transaction XDR string is empty." }],
      });
    }
    try {
      const passphrase = options?.networkPassphrase ?? Networks.TESTNET;
      transaction = TransactionBuilder.fromXDR(tx.trim(), passphrase);
    } catch (cause) {
      return ok({
        valid: false,
        errors: [
          {
            field: "xdr",
            message: `Malformed transaction XDR: ${toMessage(cause)}`,
          },
        ],
      });
    }
  } else if (tx && typeof tx === "object") {
    transaction = tx;
  } else {
    return ok({
      valid: false,
      errors: [
        {
          field: "transaction",
          message: "Transaction must be a valid Transaction object or base64 XDR string.",
        },
      ],
    });
  }

  const errors: ValidationError[] = [];
  const minFeePerOp = options?.minFeePerOp ?? 100;

  if (transaction instanceof FeeBumpTransaction) {
    // ── FeeBumpTransaction validation ──────────────────────────────────────────
    const feeSource = transaction.feeSource;
    if (
      !feeSource ||
      (!StrKey.isValidEd25519PublicKey(feeSource) &&
        !StrKey.isValidMed25519PublicKey(feeSource))
    ) {
      errors.push({
        field: "source",
        message: `Invalid fee-bump source account: ${feeSource ?? "missing"}.`,
      });
    }

    const innerTx = transaction.innerTransaction;
    if (!innerTx) {
      errors.push({
        field: "innerTransaction",
        message: "Fee-bump transaction is missing an inner transaction.",
      });
    } else {
      // Validate inner source account
      if (
        !innerTx.source ||
        (!StrKey.isValidEd25519PublicKey(innerTx.source) &&
          !StrKey.isValidMed25519PublicKey(innerTx.source))
      ) {
        errors.push({
          field: "source",
          message: `Invalid inner transaction source account: ${innerTx.source ?? "missing"}.`,
        });
      }

      // Validate sequence
      try {
        const seq = BigInt(innerTx.sequence);
        if (seq <= 0n) {
          errors.push({
            field: "sequence",
            message: `Transaction sequence number must be greater than 0, got ${innerTx.sequence}.`,
          });
        }
      } catch {
        errors.push({
          field: "sequence",
          message: `Invalid transaction sequence number: "${innerTx.sequence}".`,
        });
      }

      // Validate fee sufficiency
      const feeStroops = Number(transaction.fee);
      const innerFeeStroops = Number(innerTx.fee);
      const minRequiredFee = (innerTx.operations.length + 1) * minFeePerOp;

      if (isNaN(feeStroops) || feeStroops < minRequiredFee) {
        errors.push({
          field: "fee",
          message: `Fee ${transaction.fee} stroops is insufficient; fee-bump requires at least ${minRequiredFee} stroops for ${innerTx.operations.length} operations.`,
        });
      } else if (!isNaN(innerFeeStroops) && feeStroops < innerFeeStroops) {
        errors.push({
          field: "fee",
          message: `Fee-bump fee (${feeStroops} stroops) cannot be lower than inner transaction fee (${innerFeeStroops} stroops).`,
        });
      }
    }

    // Validate signers
    if (!transaction.signatures || transaction.signatures.length === 0) {
      errors.push({
        field: "signers",
        message: "Transaction must have at least one signature.",
      });
    }
  } else {
    // ── Standard Transaction validation ────────────────────────────────────────
    const source = transaction.source;
    if (
      !source ||
      (!StrKey.isValidEd25519PublicKey(source) &&
        !StrKey.isValidMed25519PublicKey(source))
    ) {
      errors.push({
        field: "source",
        message: `Invalid source account: ${source ?? "missing"}.`,
      });
    }

    // 1. Sequence check
    try {
      const seq = BigInt(transaction.sequence);
      if (seq <= 0n) {
        errors.push({
          field: "sequence",
          message: `Transaction sequence number must be greater than 0, got ${transaction.sequence}.`,
        });
      }
    } catch {
      errors.push({
        field: "sequence",
        message: `Invalid transaction sequence number: "${transaction.sequence}".`,
      });
    }

    // 2. Fees sufficiency check
    const feeStroops = Number(transaction.fee);
    const opCount = transaction.operations?.length ?? 0;
    const minRequiredFee = Math.max(100, opCount * minFeePerOp);

    if (isNaN(feeStroops) || feeStroops < minRequiredFee) {
      errors.push({
        field: "fee",
        message: `Fee ${transaction.fee} stroops is insufficient; minimum required is ${minRequiredFee} stroops for ${opCount} operations.`,
      });
    }

    // 3. Signers check
    if (!transaction.signatures || transaction.signatures.length === 0) {
      errors.push({
        field: "signers",
        message: "Transaction must have at least one signature.",
      });
    }
  }

  return ok({
    valid: errors.length === 0,
    errors,
  });
}
