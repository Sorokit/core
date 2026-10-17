import type {
  AssetBalance,
  BalanceAlert,
  BalanceAlertRule,
} from "./types";

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
 *
 * Handling of Invalid and Null Values (#747):
 * - **Logged & Skipped**: If `newFloat` is null, NaN, negative, or non-finite,
 *   a warning is logged and the comparison is skipped to avoid false alerts or crashes.
 * - **Baseline Guards**: If an existing baseline (`oldFloat`) is NaN, negative,
 *   or non-finite, a warning is logged and the comparison is skipped.
 * - **Threshold Guards**: If `rule.threshold` is null, NaN, negative, or non-finite,
 *   a warning is logged and the rule is skipped.
 * - **Consistent Null Baseline**: When no baseline exists (`oldFloat === null`),
 *   `below` and `above` evaluate against current balance alone (firing if initial
 *   state crosses threshold), whereas `change_percent` requires a non-zero baseline
 *   and consistently does not fire.
 * - **No Errors Thrown**: All invalid states are safely handled by logging a warning
 *   and skipping without throwing, preserving stream stability.
 */
export function evaluateBalanceAlerts(
  rules: BalanceAlertRule[],
  oldBalances: AssetBalance[],
  newBalances: AssetBalance[],
): BalanceAlert[] {
  if (!Array.isArray(rules) || rules.length === 0) return [];
  if (!Array.isArray(newBalances) || newBalances.length === 0) return [];

  const safeOldBalances = Array.isArray(oldBalances) ? oldBalances : [];
  const alerts: BalanceAlert[] = [];

  for (const rule of rules) {
    if (!rule || typeof rule !== "object" || typeof rule.assetCode !== "string") {
      continue;
    }

    if (
      typeof rule.threshold !== "number" ||
      Number.isNaN(rule.threshold) ||
      !Number.isFinite(rule.threshold) ||
      rule.threshold < 0
    ) {
      console.warn(
        `[sorokit] evaluateBalanceAlerts: invalid threshold for rule "${rule.id ?? rule.assetCode}" (value: ${rule.threshold}). Skipping rule.`,
      );
      continue;
    }

    const newBal = findBalance(newBalances, rule.assetCode, rule.assetIssuer);
    if (!newBal) continue;

    const newFloat = extractBalanceFloat(newBal);
    if (!isValidBalance(newFloat)) {
      console.warn(
        `[sorokit] evaluateBalanceAlerts: invalid new balance for asset "${rule.assetCode}" (value: ${newFloat}). Skipping alert evaluation.`,
      );
      continue;
    }

    const oldBal = findBalance(safeOldBalances, rule.assetCode, rule.assetIssuer);
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
            `[sorokit] evaluateBalanceAlerts: invalid baseline balance for asset "${rule.assetCode}" (value: ${parsedOld}). Skipping alert evaluation.`,
          );
          continue;
        }
        oldFloat = parsedOld;
      }
    }

    let fired = false;
    let changePercent: number | null = null;

    switch (rule.condition) {
      case "below":
        fired =
          newFloat < rule.threshold &&
          (oldFloat === null || oldFloat >= rule.threshold);
        break;
      case "above":
        fired =
          newFloat > rule.threshold &&
          (oldFloat === null || oldFloat <= rule.threshold);
        break;
      case "change_percent":
        if (oldFloat !== null && oldFloat !== 0) {
          changePercent = ((newFloat - oldFloat) / oldFloat) * 100;
          fired = Math.abs(changePercent) >= rule.threshold;
        }
        break;
      default:
        console.warn(
          `[sorokit] evaluateBalanceAlerts: unknown alert condition "${(rule as any).condition}" for asset "${rule.assetCode}". Skipping rule.`,
        );
        continue;
    }

    if (fired) {
      alerts.push({
        rule,
        assetCode: newBal.assetCode,
        assetIssuer: newBal.assetIssuer,
        oldBalance:
          oldBal?.balance != null ? String(oldBal.balance) : String(newBal.balance),
        newBalance: String(newBal.balance),
        changePercent,
      });
    }
  }

  return alerts;
}

