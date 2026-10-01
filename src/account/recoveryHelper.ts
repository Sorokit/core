import { Account, BASE_FEE, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { getAccount } from "./getAccount";
import { getSigners, getThresholds } from "./signers";
import type { AccountSigners, AccountThresholds } from "./signers";
import { isValidStellarPublicKey } from "./keyRotation";
import { DEFAULT_TX_TIMEOUT_SECONDS } from "../shared/constants";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { ResolvedNetworkConfig } from "../shared/types";

export const DEFAULT_RECOVERY_WAIT_MS = 48 * 60 * 60 * 1000;

export interface RecoveryPlanStep {
  action: "add_recovery_signer" | "disable_master_key" | "wait" | "remove_old_signer";
  title: string;
  status: "complete" | "recommended";
  waitMs?: number;
}

export interface RecoveryPlan {
  account: string;
  activeSignerCount: number;
  hasRecoverySigner: boolean;
  thresholds: AccountThresholds;
  steps: RecoveryPlanStep[];
}

interface SigningState {
  signers: AccountSigners;
  thresholds: AccountThresholds;
}

function thresholdsAreSafe(thresholds: AccountThresholds): boolean {
  return thresholds.low > 0 &&
    thresholds.low <= thresholds.medium &&
    thresholds.medium <= thresholds.high;
}

async function loadSigningState(
  horizonUrl: string,
  account: string,
): Promise<SorokitResult<SigningState>> {
  const [signers, thresholds] = await Promise.all([
    getSigners(horizonUrl, account),
    getThresholds(horizonUrl, account),
  ]);
  if (signers.status === "error") return signers;
  if (thresholds.status === "error") return thresholds;
  return ok({ signers: signers.data, thresholds: thresholds.data });
}

async function buildSetOptionsTransaction(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  account: string,
  options: Parameters<typeof Operation.setOptions>[0],
): Promise<SorokitResult<string>> {
  const accountResult = await getAccount(horizonUrl, account);
  if (accountResult.status === "error") return accountResult;
  try {
    const source = new Account(account, accountResult.data.sequence);
    const transaction = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: networkConfig.networkPassphrase,
    })
      .addOperation(Operation.setOptions(options))
      .setTimeout(DEFAULT_TX_TIMEOUT_SECONDS)
      .build();
    return ok(transaction.toXDR());
  } catch (cause) {
    return err(SorokitErrorCode.TX_BUILD_FAILED, "Failed to build recovery transaction.", cause);
  }
}

function validateKeys(account: string, key: string): SorokitResult<never> | null {
  if (!isValidStellarPublicKey(account) || !isValidStellarPublicKey(key)) {
    return err(SorokitErrorCode.INVALID_ADDRESS, "Account and signer must be valid Stellar public keys.");
  }
  return null;
}

/** Add a low-weight backup signer without changing the account thresholds. */
export async function addRecoverySigner(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  account: string,
  recoveryKey: string,
  recoveryWeight = 1,
): Promise<SorokitResult<string>> {
  const invalid = validateKeys(account, recoveryKey);
  if (invalid) return invalid;
  if (!Number.isInteger(recoveryWeight) || recoveryWeight < 1 || recoveryWeight > 255) {
    return err(SorokitErrorCode.VALIDATION, "Recovery signer weight must be an integer from 1 to 255.");
  }

  const state = await loadSigningState(horizonUrl, account);
  if (state.status === "error") return state;
  const { signers, thresholds } = state.data;
  if (!thresholdsAreSafe(thresholds)) {
    return err(SorokitErrorCode.VALIDATION, "Account thresholds must be positive and ordered before adding a recovery signer.");
  }
  if (recoveryWeight >= thresholds.high) {
    return err(SorokitErrorCode.VALIDATION, "Recovery signer weight must be below the high threshold.");
  }
  if (signers.signers.some((signer) => signer.key === recoveryKey && signer.weight > 0)) {
    return err(SorokitErrorCode.VALIDATION, "Recovery key is already an active signer.");
  }
  const activeSigners = signers.signers.filter((signer) => signer.weight > 0).length;
  const resultingWeight = signers.signers.reduce((total, signer) => total + signer.weight, 0) + recoveryWeight;
  if (activeSigners + 1 < 2 || resultingWeight < thresholds.high) {
    return err(SorokitErrorCode.VALIDATION, "Recovery signer would leave too few signers or insufficient weight for the high threshold.");
  }

  return buildSetOptionsTransaction(horizonUrl, networkConfig, account, {
    signer: { ed25519PublicKey: recoveryKey, weight: recoveryWeight },
  });
}

/** Add a replacement signer and disable the account's master-key weight. */
export async function rotateKeys(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  account: string,
  newKey: string,
  newKeyWeight = 1,
): Promise<SorokitResult<string>> {
  const invalid = validateKeys(account, newKey);
  if (invalid) return invalid;
  if (!Number.isInteger(newKeyWeight) || newKeyWeight < 1 || newKeyWeight > 255) {
    return err(SorokitErrorCode.VALIDATION, "Replacement signer weight must be an integer from 1 to 255.");
  }

  const state = await loadSigningState(horizonUrl, account);
  if (state.status === "error") return state;
  const { signers, thresholds } = state.data;
  if (!thresholdsAreSafe(thresholds)) {
    return err(SorokitErrorCode.VALIDATION, "Account thresholds must be positive and ordered before key rotation.");
  }
  if (signers.masterWeight <= 0) {
    return err(SorokitErrorCode.VALIDATION, "The account master key is already disabled.");
  }
  if (signers.signers.some((signer) => signer.key === newKey && signer.weight > 0)) {
    return err(SorokitErrorCode.VALIDATION, "Replacement key is already an active signer.");
  }
  const nonMasterSigners = signers.signers.filter((signer) => signer.type !== "master" && signer.weight > 0);
  const resultingWeight = signers.signers.reduce((total, signer) => total + signer.weight, 0) - signers.masterWeight + newKeyWeight;
  if (nonMasterSigners.length + 1 < 2 || resultingWeight < thresholds.high) {
    return err(SorokitErrorCode.VALIDATION, "Rotation must preserve at least two active signers and enough weight for the high threshold.");
  }

  return buildSetOptionsTransaction(horizonUrl, networkConfig, account, {
    signer: { ed25519PublicKey: newKey, weight: newKeyWeight },
    masterWeight: 0,
  });
}

/** Remove an old signer only after the configured recovery waiting period. */
export async function removeOldSigner(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  account: string,
  oldKey: string,
  rotatedAt: number | string | Date,
  options: { waitMs?: number; now?: number } = {},
): Promise<SorokitResult<string>> {
  const invalid = validateKeys(account, oldKey);
  if (invalid) return invalid;
  const rotationTime = rotatedAt instanceof Date
    ? rotatedAt.getTime()
    : typeof rotatedAt === "number"
      ? rotatedAt
      : /^\d+$/.test(rotatedAt)
        ? Number(rotatedAt)
        : Date.parse(rotatedAt);
  const now = options.now ?? Date.now();
  const waitMs = options.waitMs ?? DEFAULT_RECOVERY_WAIT_MS;
  if (!Number.isFinite(rotationTime) || rotationTime > now || !Number.isFinite(waitMs) || waitMs < 0) {
    return err(SorokitErrorCode.VALIDATION, "Rotation time and recovery wait period must be valid.");
  }
  if (now - rotationTime < waitMs) {
    return err(SorokitErrorCode.VALIDATION, "The recovery waiting period has not elapsed.");
  }

  const state = await loadSigningState(horizonUrl, account);
  if (state.status === "error") return state;
  const { signers, thresholds } = state.data;
  if (!thresholdsAreSafe(thresholds)) {
    return err(SorokitErrorCode.VALIDATION, "Account thresholds must be positive and ordered before removing a signer.");
  }
  const signer = signers.signers.find((entry) => entry.key === oldKey && entry.type !== "master" && entry.weight > 0);
  if (!signer) return err(SorokitErrorCode.VALIDATION, "Old key is not an active non-master signer.");
  const remaining = signers.signers.filter((entry) => entry.key !== oldKey && entry.weight > 0);
  const remainingWeight = remaining.reduce((total, entry) => total + entry.weight, 0);
  if (remaining.length < 2 || remainingWeight < thresholds.high) {
    return err(SorokitErrorCode.VALIDATION, "Removing this signer would violate the minimum signer count or high threshold.");
  }

  return buildSetOptionsTransaction(horizonUrl, networkConfig, account, {
    signer: { ed25519PublicKey: oldKey, weight: 0 },
  });
}

/** Describe a conservative, multi-signer recovery sequence for an account. */
export async function getRecoveryPlan(
  horizonUrl: string,
  account: string,
): Promise<SorokitResult<RecoveryPlan>> {
  if (!isValidStellarPublicKey(account)) {
    return err(SorokitErrorCode.INVALID_ADDRESS, "A valid Stellar account public key is required.");
  }
  const state = await loadSigningState(horizonUrl, account);
  if (state.status === "error") return state;
  const active = state.data.signers.signers.filter((signer) => signer.weight > 0);
  const hasRecoverySigner = active.some((signer) => signer.type !== "master");
  return ok({
    account,
    activeSignerCount: active.length,
    hasRecoverySigner,
    thresholds: state.data.thresholds,
    steps: [
      { action: "add_recovery_signer", title: "Add a recovery signer", status: hasRecoverySigner ? "complete" : "recommended" },
      { action: "disable_master_key", title: "Disable the master key after signing authority is confirmed", status: state.data.signers.masterWeight === 0 ? "complete" : "recommended" },
      { action: "wait", title: "Wait 48 hours before removing the old signer", status: "recommended", waitMs: DEFAULT_RECOVERY_WAIT_MS },
      { action: "remove_old_signer", title: "Remove the old signer after the waiting period", status: "recommended" },
    ],
  });
}