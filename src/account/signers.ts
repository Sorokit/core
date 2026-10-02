import { Horizon } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { isNotFoundError, toMessage } from "../shared";

export interface AccountSigner { key: string; type: string; weight: number; }
export interface AccountSigners { masterWeight: number; signers: AccountSigner[]; }
export interface AccountThresholds { low: number; medium: number; high: number; }
export type SigningOperation = string | { type: string };
export interface SigningRequirement { operation: string; threshold: "low" | "medium" | "high"; requiredWeight: number; availableWeight: number; sufficient: boolean; signers: AccountSigner[]; }

async function loadAccount(horizonUrl: string, publicKey: string): Promise<any> {
  return new Horizon.Server(horizonUrl).loadAccount(publicKey);
}
function failure(publicKey: string, cause: unknown): SorokitResult<never> {
  const notFound = isNotFoundError(cause);
  return err(notFound ? SorokitErrorCode.ACCOUNT_NOT_FOUND : SorokitErrorCode.ACCOUNT_FETCH_FAILED,
    notFound ? `Account not found: ${publicKey}` : `Failed to fetch account ${publicKey}: ${toMessage(cause)}`, cause);
}

export async function getSigners(horizonUrl: string, publicKey: string): Promise<SorokitResult<AccountSigners>> {
  try {
    const account = await loadAccount(horizonUrl, publicKey);
    const thresholds = account.thresholds ?? {};
    const masterWeight = Number(thresholds.master_weight ?? 0);
    const signers: AccountSigner[] = [
      { key: publicKey, type: "master", weight: masterWeight },
      ...(account.signers ?? []).map((s: any) => ({ key: String(s.key), type: String(s.type ?? "ed25519_public_key"), weight: Number(s.weight ?? 0) })),
    ];
    return ok({ masterWeight, signers });
  } catch (cause) { return failure(publicKey, cause); }
}

export async function getThresholds(horizonUrl: string, publicKey: string): Promise<SorokitResult<AccountThresholds>> {
  try {
    const thresholds = (await loadAccount(horizonUrl, publicKey)).thresholds ?? {};
    return ok({ low: Number(thresholds.low_threshold ?? 0), medium: Number(thresholds.med_threshold ?? 0), high: Number(thresholds.high_threshold ?? 0) });
  } catch (cause) { return failure(publicKey, cause); }
}

export async function analyzeSigningRequirement(horizonUrl: string, publicKey: string, operation: SigningOperation): Promise<SorokitResult<SigningRequirement>> {
  try {
    const account = await loadAccount(horizonUrl, publicKey);
    const thresholds = account.thresholds ?? {};
    const name = typeof operation === "string" ? operation : operation.type;
    const lowOperations = new Set(["allow_trust", "bump_sequence", "manage_data", "set_options"]);
    const level: "low" | "medium" | "high" = name === "account_merge" ? "high" : lowOperations.has(name) ? "low" : "medium";
    const requiredWeight = Number(thresholds[`${level}_threshold`] ?? 0);
    const signers: AccountSigner[] = [{ key: publicKey, type: "master", weight: Number(thresholds.master_weight ?? 0) }, ...(account.signers ?? []).map((s: any) => ({ key: String(s.key), type: String(s.type ?? "ed25519_public_key"), weight: Number(s.weight ?? 0) }))];
    const availableWeight = signers.reduce((sum, signer) => sum + signer.weight, 0);
    return ok({ operation: name, threshold: level, requiredWeight, availableWeight, sufficient: availableWeight >= requiredWeight, signers });
  } catch (cause) { return failure(publicKey, cause); }
}
