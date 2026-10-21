import type {
  AccountReserveStructure,
  AssetBalance,
  BalanceAlert,
  BalanceAlertRule,
} from "./types";

/**
 * Stellar protocol constants for reserve calculation.
 * Base reserve is 0.5 XLM = 5,000,000 stroops.
 * Base account reserves is 2 (account creation + master key).
 */
export const BASE_RESERVE_XLM = 0.5;
export const BASE_ACCOUNT_RESERVES = 2;
export const STROOPS_PER_XLM = 10_000_000n;

/**
 * Calculate the minimum required XLM balance (reserve) for an account structure.
 *
 * Reserve formula per Stellar protocol:
 *   Minimum Reserve (XLM) = (2 + subentries) × 0.5 XLM
 *
 * Subentries are tracked by Horizon and include:
 *   - Trustlines (non-native assets)
 *   - Offers
 *   - Additional signers (beyond master key)
 *   - Data entries (manage_data)
 *
 * @param structure - Account reserve context (subentryCount, trustlines, signers, etc.).
 * @param baseReserveXlm - Base reserve per entry in XLM (default: 0.5 XLM).
 * @returns Minimum reserve in XLM.
 */
export function calculateMinimumReserve(
  structure?: AccountReserveStructure,
  baseReserveXlm = BASE_RESERVE_XLM,
): number {
  if (!structure) {
    return BASE_ACCOUNT_RESERVES * baseReserveXlm;
  }

  let subentries = 0;
  if (typeof structure.subentryCount === "number" && structure.subentryCount >= 0) {
    subentries = structure.subentryCount;
  } else if (typeof structure.numSubentries === "number" && structure.numSubentries >= 0) {
    subentries = structure.numSubentries;
  } else {
    if (Array.isArray(structure.trustlines)) subentries += structure.trustlines.length;
    else if (typeof structure.trustlines === "number" && structure.trustlines > 0) subentries += structure.trustlines;

    if (Array.isArray(structure.signers)) subentries += Math.max(0, structure.signers.length - 1);
    else if (typeof structure.signers === "number" && structure.signers > 0) subentries += Math.max(0, structure.signers - 1);

    if (Array.isArray(structure.offers)) subentries += structure.offers.length;
    else if (typeof structure.offers === "number" && structure.offers > 0) subentries += structure.offers;

    if (Array.isArray(structure.dataEntries)) subentries += structure.dataEntries.length;
    else if (typeof structure.dataEntries === "number" && structure.dataEntries > 0) subentries += structure.dataEntries;
  }

  return (BASE_ACCOUNT_RESERVES + subentries) * baseReserveXlm;
}

/**
 * Calculate minimum reserve in stroops (1 XLM = 10,000,000 stroops).
 */
export function calculateMinimumReserveStroops(
  structure?: AccountReserveStructure,
  baseReserveXlm = BASE_RESERVE_XLM,
): bigint {
  const xlm = calculateMinimumReserve(structure, baseReserveXlm);
  return BigInt(Math.round(xlm * 10_000_000));
}

/**
 * Convenience helper to create a minReserveAlert rule.
 */
export function minReserveAlert(options?: {
  bufferXlm?: number;
  threshold?: number;
  id?: string;
}): BalanceAlertRule {
  const buffer = options?.bufferXlm ?? options?.threshold ?? 0;
  return {
    id: options?.id ?? "min_reserve_alert",
    assetCode: "XLM",
    assetIssuer: null,
    condition: "min_reserve",
    threshold: buffer,
    bufferXlm: buffer,
  };
}

/**
 * Determine if a numeric value represents a valid Stellar balance amount.
 * Valid balances must be non-negative finite numbers (>= 0 and not NaN).
 */
function isValidBalance(val: unknown): val is number {
  return (
    typeof val === "number" &&
    !Number.isNaN(val) &&
    Number.isFinite(val) &&
    val >= 0
  );
}

/**
 * Safely parse a balance float from an AssetBalance object, falling back to
 * `parseFloat(balance)` if `balanceFloat` is missing or not a number.
 */
function extractBalanceFloat(bal: AssetBalance): number {
  if (typeof bal.balanceFloat === "number" && !Number.isNaN(bal.balanceFloat)) {
    return bal.balanceFloat;
  }
  if (typeof bal.balance === "string") {
    return parseFloat(bal.balance);
  }
  return NaN;
}

/**
 * Find the balance matching a rule's asset code and (optional) issuer.
 * When `assetIssuer` is omitted on the rule, matching is by code alone.
 */
function findBalance(
  balances: AssetBalance[],
  assetCode: string,
  assetIssuer: string | null | undefined,
): AssetBalance | undefined {
  if (!Array.isArray(balances)) return undefined;
  return balances.find((b) => {
    if (!b || typeof b !== "object") return false;
    if (b.assetCode !== assetCode) return false;
    if (assetIssuer === undefined) return true;
    return (b.assetIssuer ?? null) === (assetIssuer ?? null);
  });
}

/**
 * Evaluate a set of balance alert rules against the transition from one set of
 * balances to the next, returning every alert whose condition was crossed.
 *
 * Semantics:
 * - `below` / `above` fire when the new balance is past the threshold and the
 *   previous balance was not (a crossing). With no baseline, the current value
 *   alone decides — so an account that starts below a threshold alerts once.
 * - `change_percent` fires when the absolute percentage change between polls
 *   meets the threshold. It requires a non-zero baseline.
 * - `min_reserve` fires when native XLM balance approaches or drops below the
 *   calculated minimum reserve requirements for the account.
 */
export function evaluateBalanceAlerts(
  rules: BalanceAlertRule[],
  oldBalances: AssetBalance[],
  newBalances: AssetBalance[],
  accountContext?: AccountReserveStructure,
): BalanceAlert[] {
  if (!Array.isArray(rules) || rules.length === 0) return [];
  if (!Array.isArray(newBalances) || newBalances.length === 0) return [];

  const safeOldBalances = Array.isArray(oldBalances) ? oldBalances : [];
  const alerts: BalanceAlert[] = [];

  for (const rule of rules) {
    if (!rule || typeof rule !== "object") {
      continue;
    }

    const isMinReserve = rule.condition === "min_reserve";
    const assetCode = isMinReserve ? (rule.assetCode || "XLM") : rule.assetCode;
    if (typeof assetCode !== "string") {
      continue;
    }

    const thresholdVal = isMinReserve
      ? (rule.threshold ?? rule.bufferXlm ?? 0)
      : rule.threshold;

    if (
      typeof thresholdVal !== "number" ||
      Number.isNaN(thresholdVal) ||
      !Number.isFinite(thresholdVal) ||
      thresholdVal < 0
    ) {
      console.warn(
        `[sorokit] evaluateBalanceAlerts: invalid threshold for rule "${rule.id ?? assetCode}" (value: ${thresholdVal}). Skipping rule.`,
      );
      continue;
    }

    const newBal = findBalance(
      newBalances,
      assetCode,
      isMinReserve ? null : rule.assetIssuer,
    );
    if (!newBal) continue;

    const newFloat = extractBalanceFloat(newBal);
    if (!isValidBalance(newFloat)) {
      console.warn(
        `[sorokit] evaluateBalanceAlerts: invalid new balance for asset "${assetCode}" (value: ${newFloat}). Skipping alert evaluation.`,
      );
      continue;
    }

    const oldBal = findBalance(
      safeOldBalances,
      assetCode,
      isMinReserve ? null : rule.assetIssuer,
    );
    let oldFloat: number | null = null;

    if (oldBal !== undefined) {
      if (
        (oldBal.balanceFloat === null || oldBal.balanceFloat === undefined) &&
        (oldBal.balance === null || oldBal.balance === undefined)
      ) {
        oldFloat = null;
      } else {
        const parsedOld = extractBalanceFloat(oldBal);
        if (!isValidBalance(parsedOld)) {
          console.warn(
            `[sorokit] evaluateBalanceAlerts: invalid baseline balance for asset "${assetCode}" (value: ${parsedOld}). Skipping alert evaluation.`,
          );
          continue;
        }
        oldFloat = parsedOld;
      }
    }

    let fired = false;
    let changePercent: number | null = null;
    let minReserve: number | undefined;

    switch (rule.condition) {
      case "below":
        fired =
          newFloat < thresholdVal &&
          (oldFloat === null || oldFloat >= thresholdVal);
        break;
      case "above":
        fired =
          newFloat > thresholdVal &&
          (oldFloat === null || oldFloat <= thresholdVal);
        break;
      case "change_percent":
        if (oldFloat !== null && oldFloat !== 0) {
          changePercent = ((newFloat - oldFloat) / oldFloat) * 100;
          fired = Math.abs(changePercent) >= thresholdVal;
        }
        break;
      case "min_reserve": {
        minReserve = calculateMinimumReserve(accountContext);
        const buffer = rule.bufferXlm ?? rule.threshold ?? 0;
        const effectiveLimit = minReserve + buffer;
        fired =
          newFloat <= effectiveLimit &&
          (oldFloat === null || oldFloat > effectiveLimit);
        break;
      }
      default:
        console.warn(
          `[sorokit] evaluateBalanceAlerts: unknown alert condition "${(rule as any).condition}" for asset "${assetCode}". Skipping rule.`,
        );
        continue;
    }

    if (fired) {
      const minReserveStroops =
        minReserve !== undefined
          ? BigInt(Math.round(minReserve * 10_000_000))
          : undefined;

      alerts.push({
        rule,
        assetCode: newBal.assetCode,
        assetIssuer: newBal.assetIssuer,
        oldBalance:
          oldBal?.balance != null ? String(oldBal.balance) : String(newBal.balance),
        newBalance: String(newBal.balance),
        changePercent,
        ...(minReserve !== undefined ? { minimumReserve: minReserve } : {}),
        ...(minReserveStroops !== undefined ? { minimumReserveStroops } : {}),
        ...(isMinReserve && minReserve !== undefined
          ? { isSubReserve: newFloat < minReserve }
          : {}),
      });
    }
  }

  return alerts;
}


