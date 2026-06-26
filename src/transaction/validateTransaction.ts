import { TransactionBuilder, StrKey } from "@stellar/stellar-sdk";
import type { Transaction, FeeBumpTransaction } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage } from "../shared";

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MIN_FEE_STROOPS = 100;
const DEFAULT_MAX_FEE_STROOPS = 100_000;

const KNOWN_NETWORK_PASSPHRASES: Record<string, string> = {
  "Public Global Stellar Network ; September 2015": "mainnet",
  "Test SDF Network ; September 2015": "testnet",
  "Test SDF Future Network ; October 2022": "futurenet",
};

// Fallback passphrase used when none is provided — allows structural parsing
const FALLBACK_PARSE_PASSPHRASE = "Test SDF Network ; September 2015";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ValidationIssue {
  field: string;
  message: string;
  severity: "error" | "warning";
}

export interface ParsedOperation {
  type: string;
  destination?: string;
  amount?: string;
  startingBalance?: string;
}

export interface TransactionValidationContext {
  xdr: string;
  fee: number;
  operationCount: number;
  networkPassphrase: string;
  operations: ParsedOperation[];
}

export type CustomValidationRule = (
  context: TransactionValidationContext,
) => ValidationIssue | null;

export interface ValidationRules {
  /** Expected network passphrase — used for network match check */
  networkPassphrase?: string;
  /** Minimum acceptable fee in stroops. Default: 100 */
  minFee?: number;
  /** Maximum acceptable fee in stroops. Default: 100_000 */
  maxFee?: number;
  /** Custom validation rules that receive the parsed transaction context */
  custom?: CustomValidationRule[];
}

export interface TransactionValidationReport {
  valid: boolean;
  issues: ValidationIssue[];
  operationCount: number;
  fee: string;
  networkPassphrase: string;
}

// ─── Implementation ───────────────────────────────────────────────────────────

/**
 * Run pre-submission validation checks on a transaction XDR.
 *
 * Checks receiver validity, positive amounts, fee sanity, and optional network
 * passphrase match. Returns a detailed validation report.
 */
export function validateTransaction(
  transactionXdr: string,
  rules?: ValidationRules,
): SorokitResult<TransactionValidationReport> {
  const parsePassphrase = rules?.networkPassphrase ?? FALLBACK_PARSE_PASSPHRASE;

  let transaction: Transaction;
  try {
    const parsed = TransactionBuilder.fromXDR(transactionXdr, parsePassphrase);
    if (isFeeBumpTransaction(parsed)) {
      transaction = parsed.innerTransaction as Transaction;
    } else {
      transaction = parsed as Transaction;
    }
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Invalid transaction XDR: ${toMessage(cause)}`,
      cause,
    );
  }

  const issues: ValidationIssue[] = [];
  const feeStroops = Number(transaction.fee);
  const minFee = rules?.minFee ?? DEFAULT_MIN_FEE_STROOPS;
  const maxFee = rules?.maxFee ?? DEFAULT_MAX_FEE_STROOPS;

  // ── Fee sanity ──────────────────────────────────────────────────────────────
  if (isNaN(feeStroops) || feeStroops < minFee) {
    issues.push({
      field: "fee",
      message: `Fee ${feeStroops} stroops is below the minimum of ${minFee} stroops`,
      severity: "error",
    });
  } else if (feeStroops > maxFee) {
    issues.push({
      field: "fee",
      message: `Fee ${feeStroops} stroops exceeds the sanity limit of ${maxFee} stroops`,
      severity: "warning",
    });
  }

  // ── Per-operation checks ────────────────────────────────────────────────────
  const parsedOps: ParsedOperation[] = [];

  for (let i = 0; i < transaction.operations.length; i++) {
    const op = transaction.operations[i];
    if (!op) continue;

    const parsed: ParsedOperation = { type: op.type };

    // Receiver validation — applies to payment, createAccount, pathPayment, etc.
    if ("destination" in op && typeof op.destination === "string") {
      parsed.destination = op.destination;
      if (!StrKey.isValidEd25519PublicKey(op.destination)) {
        issues.push({
          field: `operations[${i}].destination`,
          message: `Invalid receiver public key: "${op.destination}"`,
          severity: "error",
        });
      }
    }

    // Amount must be positive for payment operations
    if ("amount" in op && typeof op.amount === "string") {
      parsed.amount = op.amount;
      const amountFloat = parseFloat(op.amount);
      if (isNaN(amountFloat) || amountFloat <= 0) {
        issues.push({
          field: `operations[${i}].amount`,
          message: `Amount must be positive, got: "${op.amount}"`,
          severity: "error",
        });
      }
    }

    // Starting balance for createAccount operations
    if ("startingBalance" in op && typeof op.startingBalance === "string") {
      parsed.startingBalance = op.startingBalance;
      const balanceFloat = parseFloat(op.startingBalance);
      if (isNaN(balanceFloat) || balanceFloat <= 0) {
        issues.push({
          field: `operations[${i}].startingBalance`,
          message: `Starting balance must be positive, got: "${op.startingBalance}"`,
          severity: "error",
        });
      }
    }

    parsedOps.push(parsed);
  }

  // ── Network match ───────────────────────────────────────────────────────────
  if (rules?.networkPassphrase !== undefined) {
    const networkName = KNOWN_NETWORK_PASSPHRASES[rules.networkPassphrase];
    if (!networkName) {
      issues.push({
        field: "network",
        message: `Unrecognized network passphrase: "${rules.networkPassphrase}". Expected a known Stellar network passphrase.`,
        severity: "warning",
      });
    }
  }

  // ── Custom rules ─────────────────────────────────────────────────────────────
  if (rules?.custom && rules.custom.length > 0) {
    const context: TransactionValidationContext = {
      xdr: transactionXdr,
      fee: feeStroops,
      operationCount: transaction.operations.length,
      networkPassphrase: parsePassphrase,
      operations: parsedOps,
    };

    for (const rule of rules.custom) {
      const issue = rule(context);
      if (issue !== null) {
        issues.push(issue);
      }
    }
  }

  const hasErrors = issues.some((issue) => issue.severity === "error");

  return ok({
    valid: !hasErrors,
    issues,
    operationCount: transaction.operations.length,
    fee: String(transaction.fee),
    networkPassphrase: parsePassphrase,
  });
}

function isFeeBumpTransaction(
  tx: Transaction | FeeBumpTransaction,
): tx is FeeBumpTransaction {
  return "innerTransaction" in tx;
}
