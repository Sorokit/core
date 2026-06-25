import type {
  AssetBalance,
  BalanceAlert,
  BalanceAlertRule,
} from "./types";

/**
 * Find the balance matching a rule's asset code and (optional) issuer.
 * When `assetIssuer` is omitted on the rule, matching is by code alone.
 */
function findBalance(
  balances: AssetBalance[],
  assetCode: string,
  assetIssuer: string | null | undefined,
): AssetBalance | undefined {
  return balances.find((b) => {
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
 * Pure and side-effect free — `streamAccount` dispatches the results to `onAlert`.
 */
export function evaluateBalanceAlerts(
  rules: BalanceAlertRule[],
  oldBalances: AssetBalance[],
  newBalances: AssetBalance[],
): BalanceAlert[] {
  const alerts: BalanceAlert[] = [];

  for (const rule of rules) {
    const newBal = findBalance(newBalances, rule.assetCode, rule.assetIssuer);
    if (!newBal) continue;

    const oldBal = findBalance(oldBalances, rule.assetCode, rule.assetIssuer);
    const oldFloat = oldBal?.balanceFloat ?? null;
    const newFloat = newBal.balanceFloat;

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
    }

    if (fired) {
      alerts.push({
        rule,
        assetCode: newBal.assetCode,
        assetIssuer: newBal.assetIssuer,
        oldBalance: oldBal?.balance ?? newBal.balance,
        newBalance: newBal.balance,
        changePercent,
      });
    }
  }

  return alerts;
}
