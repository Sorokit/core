import { getAccount } from "./getAccount";
import { getSigners, getThresholds } from "./signers";
import { assessAccountHealth } from "./accountHealth";
import type { AccountHealthReport } from "./accountHealth";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

export type HealthRiskLevel = "safe" | "warning" | "critical";

export interface HealthData {
  score: number;
  riskLevel: HealthRiskLevel;
  risks: string[];
  /** Spendable XLM divided by the total native balance. */
  balanceRatio: number;
  spendableNativeBalance: number;
  /** Estimated reserve using the default 0.5 XLM base reserve per entry. */
  minimumNativeBalance: number;
  hasRecoverySigner: boolean;
  security: AccountHealthReport;
}

const DEFAULT_BASE_RESERVE_XLM = 0.5;

function riskLevel(score: number, belowReserve: boolean): HealthRiskLevel {
  if (belowReserve || score < 50) return "critical";
  if (score < 85) return "warning";
  return "safe";
}

/** Fetch and score account signing security, recovery coverage, and XLM reserve health. */
export async function calculateHealthScore(
  horizonUrl: string,
  publicKey: string,
): Promise<SorokitResult<HealthData>> {
  const [accountResult, signersResult, thresholdsResult] = await Promise.all([
    getAccount(horizonUrl, publicKey),
    getSigners(horizonUrl, publicKey),
    getThresholds(horizonUrl, publicKey),
  ]);
  if (accountResult.status === "error") return accountResult;
  if (signersResult.status === "error") return signersResult;
  if (thresholdsResult.status === "error") return thresholdsResult;

  const native = accountResult.data.balances.find((balance) => balance.assetType === "native");
  const nativeBalance = native?.balanceFloat ?? (native ? Number(native.balance) : 0);
  try {
    return ok(assessHealthScore({
      publicKey,
      masterWeight: signersResult.data.masterWeight,
      thresholds: thresholdsResult.data,
      signers: signersResult.data.signers,
      nativeBalance,
      subentryCount: accountResult.data.subentryCount,
    }));
  } catch (cause) {
    return err(SorokitErrorCode.VALIDATION, "Account data cannot be used for a health assessment.", cause);
  }
}

/** Pure health assessment for already-fetched account data. */
export function assessHealthScore(input: {
  publicKey?: string;
  masterWeight: number;
  thresholds: { low: number; medium: number; high: number };
  signers: { key: string; type: string; weight: number }[];
  nativeBalance: number;
  subentryCount: number;
}): HealthData {
  if (!Number.isFinite(input.nativeBalance) || input.nativeBalance < 0 || !Number.isInteger(input.subentryCount) || input.subentryCount < 0) {
    throw new TypeError("Native balance and subentry count must be non-negative finite values.");
  }
  const security = assessAccountHealth({
    ...(input.publicKey !== undefined ? { publicKey: input.publicKey } : {}),
    masterWeight: input.masterWeight,
    thresholds: input.thresholds,
    signers: input.signers,
  });
  const hasRecoverySigner = input.signers.some((signer) => signer.type !== "master" && signer.weight > 0);
  const minimumNativeBalance = (2 + input.subentryCount) * DEFAULT_BASE_RESERVE_XLM;
  const spendableNativeBalance = Math.max(0, input.nativeBalance - minimumNativeBalance);
  const balanceRatio = input.nativeBalance > 0
    ? Math.max(0, Math.min(1, spendableNativeBalance / input.nativeBalance))
    : 0;
  const belowReserve = input.nativeBalance < minimumNativeBalance;
  const balanceScore = belowReserve ? 0 : balanceRatio >= 0.5 ? 100 : balanceRatio >= 0.2 ? 70 : 40;
  let score = Math.round(security.score * 0.85 + balanceScore * 0.15);
  const risks = [...security.risks];

  if (!hasRecoverySigner) {
    risks.push("No active backup signer is configured.");
    score = Math.max(0, score - 10);
  }
  if (belowReserve) {
    risks.push(`Native balance is below the estimated minimum reserve of ${minimumNativeBalance} XLM.`);
  } else if (balanceRatio < 0.1) {
    risks.push("Less than 10% of the native balance is available above the estimated reserve.");
  }

  return {
    score,
    riskLevel: riskLevel(score, belowReserve),
    risks,
    balanceRatio,
    spendableNativeBalance,
    minimumNativeBalance,
    hasRecoverySigner,
    security,
  };
}