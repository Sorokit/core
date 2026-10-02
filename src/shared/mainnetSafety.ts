/**
 * Mainnet Safety Guards and Warnings (#577)
 *
 * Prevents accidental execution of high-value transactions on Stellar Mainnet
 * by inspecting native XLM amounts across operations and enforcing safety thresholds.
 */

import { TransactionBuilder, Operation, FeeBumpTransaction, type xdr } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "./response";
import type { SorokitResult } from "./response";
import type { SorokitLogger } from "./logger";

/** Default safety threshold for Mainnet transactions (1,000 XLM) */
export const DEFAULT_MAINNET_SAFETY_THRESHOLD_XLM = 1000;

/** Official Stellar Mainnet Network Passphrase */
export const MAINNET_NETWORK_PASSPHRASE = "Public Global Stellar Network ; September 2015";

/** Options controlling Mainnet safety checks */
export interface MainnetSafetyOptions {
  /** Explicit confirmation for over-limit or unbounded Mainnet XLM exposure. */
  bypassMainnetSafety?: boolean;
  /** Finite, nonnegative threshold in XLM. Default: 1000 XLM. */
  mainnetSafetyThresholdXlm?: number;
  /** Optional logger for safety warning outputs */
  logger?: SorokitLogger;
}

/** Check if a network passphrase corresponds to Stellar Mainnet */
export function isMainnetNetwork(networkPassphrase: string): boolean {
  return typeof networkPassphrase === "string" && networkPassphrase === MAINNET_NETWORK_PASSPHRASE;
}

// Convert decimal values exactly, including scientific notation used by numeric
// thresholds. Fractional stroops are rounded down for the strict > comparison.
function toStroops(value: string): bigint {
  const [mantissa = "", exponent = "0"] = value.toLowerCase().split("e");
  const [whole = "", fraction = ""] = mantissa.split(".");
  const digits = BigInt(whole + fraction);
  const scale = 7 + Number(exponent) - fraction.length;
  return scale >= 0
    ? digits * 10n ** BigInt(scale)
    : digits / 10n ** BigInt(-scale);
}

function inspectTransaction(signedXdr: string, networkPassphrase: string) {
  const tx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
  const innerTx = tx instanceof FeeBumpTransaction ? tx.innerTransaction : tx;
  const operations = innerTx.operations ?? [];

  let totalStroops = 0n;
  const unboundedOperations: string[] = [];
  let rawOperations: xdr.Operation[] | undefined;

  for (const [index, op] of operations.entries()) {
    switch (op.type) {
      case "payment": {
        const paymentOp = op as Operation.Payment;
        if (!paymentOp.asset || paymentOp.asset.isNative()) {
          totalStroops += toStroops(paymentOp.amount || "0");
        }
        break;
      }
      case "createAccount": {
        const createOp = op as Operation.CreateAccount;
        totalStroops += toStroops(createOp.startingBalance || "0");
        break;
      }
      case "pathPaymentStrictReceive": {
        const pathOp = op as Operation.PathPaymentStrictReceive;
        if (pathOp.sendAsset.isNative()) {
          // Use the spend ceiling even when both ends are native XLM.
          totalStroops += toStroops(pathOp.sendMax);
        } else if (pathOp.destAsset.isNative()) {
          totalStroops += toStroops(pathOp.destAmount);
        }
        break;
      }
      case "pathPaymentStrictSend": {
        const pathOp = op as Operation.PathPaymentStrictSend;
        if (pathOp.sendAsset && pathOp.sendAsset.isNative()) {
          totalStroops += toStroops(pathOp.sendAmount || "0");
        } else if (pathOp.destAsset && pathOp.destAsset.isNative()) {
          totalStroops += toStroops(pathOp.destMin);
          // A minimum received amount is not an upper bound on XLM moved.
          unboundedOperations.push(op.type);
        }
        break;
      }
      case "manageSellOffer":
      case "createPassiveSellOffer": {
        if (op.selling.isNative()) {
          totalStroops += toStroops(op.amount);
        } else if (op.buying.isNative() && toStroops(op.amount) > 0n) {
          // The execution price may improve; native receipts are not bounded.
          unboundedOperations.push(op.type);
        }
        break;
      }
      case "manageBuyOffer": {
        if (op.buying.isNative()) {
          totalStroops += toStroops(op.buyAmount);
        } else if (op.selling.isNative()) {
          // Read the original rational price to avoid SDK decimal rounding.
          if (!rawOperations) {
            const envelope = innerTx.toEnvelope();
            const rawTx = envelope.switch().name === "envelopeTypeTxV0" ? envelope.v0().tx() : envelope.v1().tx();
            rawOperations = rawTx.operations();
          }
          const price = rawOperations[index]!.body().manageBuyOfferOp().price();
          const numerator = BigInt(price.n());
          const denominator = BigInt(price.d());
          if (numerator <= 0n || denominator <= 0n) throw new Error("Invalid offer price");
          totalStroops += (toStroops(op.buyAmount) * numerator + denominator - 1n) / denominator;
        }
        break;
      }
      // These operations do not transfer native XLM (fees and reserve changes
      // are outside the operation-amount threshold).
      case "setOptions":
      case "changeTrust":
      case "allowTrust":
      case "manageData":
      case "bumpSequence":
      case "beginSponsoringFutureReserves":
      case "endSponsoringFutureReserves":
      case "revokeSponsorship":
      case "clawback":
      case "clawbackClaimableBalance":
      case "setTrustLineFlags":
      case "extendFootprintTtl":
      case "restoreFootprint":
      case "inflation": // Disabled by the protocol.
        break;
      default:
        // Includes account merges, claims, pool operations, host functions,
        // and future operation types whose native value is not in the XDR.
        unboundedOperations.push(op.type);
        break;
      case "createClaimableBalance": {
        const claimOp = op as Operation.CreateClaimableBalance;
        if (!claimOp.asset || claimOp.asset.isNative()) {
          totalStroops += toStroops(claimOp.amount || "0");
        }
        break;
      }
    }
  }

  return { totalStroops, unboundedOperations, operationCount: operations.length, sourceAccount: innerTx.source };
}

/**
 * Return the native XLM exposure represented by operation amounts or spend ceilings.
 * Throws if the envelope is malformed or its native exposure requires ledger state.
 * The numeric result is for display; safety comparisons use exact integer stroops.
 * Fees, reserve changes and non-native asset valuations are outside this threshold.
 */
export function extractTransactionTotalXlm(signedXdr: string, networkPassphrase: string): number {
  const inspection = inspectTransaction(signedXdr, networkPassphrase);
  if (inspection.unboundedOperations.length > 0) {
    throw new Error(`Cannot bound native XLM for: ${inspection.unboundedOperations.join(", ")}`);
  }
  return Number(inspection.totalStroops) / 1e7;
}

/**
 * Perform Mainnet safety check on a transaction before submission.
 *
 * If the transaction is on Mainnet and the total XLM amount exceeds the threshold
 * (default 1000 XLM), it logs a detailed warning. If `bypassMainnetSafety` is not true,
 * it returns `SorokitErrorCode.MAINNET_SAFETY_LIMIT`. Operations whose native
 * exposure cannot be bounded from XDR also require this explicit confirmation.
 */
export function checkMainnetSafety(
  signedXdr: string,
  networkPassphrase: string,
  options?: MainnetSafetyOptions,
): SorokitResult<void> {
  if (!isMainnetNetwork(networkPassphrase)) {
    return ok(undefined);
  }

  const threshold = options?.mainnetSafetyThresholdXlm ?? DEFAULT_MAINNET_SAFETY_THRESHOLD_XLM;
  if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0) {
    return err(SorokitErrorCode.INVALID_CONFIG, "Mainnet safety threshold must be a finite, nonnegative number of XLM.");
  }

  let inspection: ReturnType<typeof inspectTransaction>;
  try {
    inspection = inspectTransaction(signedXdr, networkPassphrase);
  } catch (cause) {
    return err(SorokitErrorCode.XDR_INVALID, "Mainnet safety check could not inspect the transaction XDR.", cause);
  }
  const bypass = options?.bypassMainnetSafety === true;
  const totalXlm = Number(inspection.totalStroops) / 1e7;

  if (inspection.totalStroops > toStroops(threshold.toString()) || inspection.unboundedOperations.length > 0) {
    const reason = inspection.unboundedOperations.length > 0
      ? `native XLM exposure cannot be bounded from the envelope for ${inspection.unboundedOperations.join(", ")}`
      : `transaction total amount of ${totalXlm} XLM exceeds safety threshold of ${threshold} XLM`;

    const details = {
      totalXlm,
      unboundedOperations: inspection.unboundedOperations,
      thresholdXlm: threshold,
      bypassMainnetSafety: bypass,
      operationCount: inspection.operationCount,
      sourceAccount: inspection.sourceAccount,
    };

    if (options?.logger) {
      options.logger.warn(
        `Mainnet Safety Warning: ${reason}.`,
        details,
      );
    } else {
      console.warn(
        `[sorokit] Mainnet Safety Warning: ${reason}.`,
        details,
      );
    }

    if (!bypass) {
      return err(
        SorokitErrorCode.MAINNET_SAFETY_LIMIT,
        `Mainnet safety limit exceeded: ${reason}. Pass bypassMainnetSafety: true to proceed.`,
      );
    }
  }

  return ok(undefined);
}
