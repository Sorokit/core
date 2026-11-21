import { StrKey, Operation, TransactionBuilder, BASE_FEE } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { ResolvedNetworkConfig } from "../shared/types";
import { DEFAULT_TX_TIMEOUT_SECONDS } from "../shared/constants";
import { getAccount } from "./getAccount";
import { fetchCongestionFeeEstimate } from "../transaction/estimateFee";

export interface RotateAccountKeyParams {
  account: string;
  oldKey: string;
  newKey: string;
  newKeyWeight?: number;
  fee?: string;
}

export interface RecoveryReplacementSigner {
  key: string;
  weight: number;
}

export interface RecoverAccountKeysParams {
  account: string;
  recoveryKey: string;
  compromisedKeys?: string[];
  newKeys: RecoveryReplacementSigner[];
  lowThreshold?: number;
  medThreshold?: number;
  highThreshold?: number;
  masterWeight?: number;
  fee?: string;
}

export interface SetAccountRecoveryParams {
  account: string;
  recoveryKey: string;
  recoveryWeight?: number;
  masterWeight?: number;
  lowThreshold?: number;
  medThreshold?: number;
  highThreshold?: number;
  fee?: string;
}

export function isValidStellarPublicKey(key: string): boolean {
  if (typeof key !== "string") return false;
  return StrKey.isValidEd25519PublicKey(key);
}

export async function rotateAccountKey(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  params: RotateAccountKeyParams,
): Promise<SorokitResult<string>> {
  const { account, oldKey, newKey, newKeyWeight = 1, fee } = params;

  if (!isValidStellarPublicKey(account)) {
    return err(SorokitErrorCode.INVALID_ADDRESS, `Invalid account address: ${account}`);
  }
  if (!isValidStellarPublicKey(oldKey)) {
    return err(SorokitErrorCode.INVALID_ADDRESS, `Invalid old key address: ${oldKey}`);
  }
  if (!isValidStellarPublicKey(newKey)) {
    return err(SorokitErrorCode.INVALID_ADDRESS, `Invalid new key address: ${newKey}`);
  }
  if (oldKey === newKey) {
    return err(SorokitErrorCode.TX_BUILD_FAILED, "Old key and new key cannot be identical.");
  }

  const accountResult = await getAccount(horizonUrl, account);
  if (accountResult.status === "error") return accountResult;

  let txFee = fee;
  if (!txFee) {
    const estimate = await fetchCongestionFeeEstimate(horizonUrl, parseInt(BASE_FEE, 10), undefined, networkConfig.network);
    txFee = estimate.recommendedFee;
  }

  try {
    const sourceAccount = new (await import("@stellar/stellar-sdk")).Account(account, accountResult.data.sequence);

    const builder = new TransactionBuilder(sourceAccount, {
      fee: txFee,
      networkPassphrase: networkConfig.networkPassphrase,
    });

    builder.addOperation(
      Operation.setOptions({
        signer: { ed25519PublicKey: newKey, weight: newKeyWeight },
      }),
    );

    builder.addOperation(
      Operation.setOptions({
        signer: { ed25519PublicKey: oldKey, weight: 0 },
      }),
    );

    builder.setTimeout(DEFAULT_TX_TIMEOUT_SECONDS);
    const tx = builder.build();

    return ok(tx.toXDR());
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Failed to build key rotation transaction: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    );
  }
}

export async function setAccountRecovery(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  params: SetAccountRecoveryParams,
): Promise<SorokitResult<string>> {
  const {
    account,
    recoveryKey,
    recoveryWeight = 1,
    masterWeight,
    lowThreshold = 1,
    medThreshold = 2,
    highThreshold = 2,
    fee,
  } = params;

  if (!isValidStellarPublicKey(account)) {
    return err(SorokitErrorCode.INVALID_ADDRESS, `Invalid account address: ${account}`);
  }
  if (!isValidStellarPublicKey(recoveryKey)) {
    return err(SorokitErrorCode.INVALID_ADDRESS, `Invalid recovery key address: ${recoveryKey}`);
  }

  const accountResult = await getAccount(horizonUrl, account);
  if (accountResult.status === "error") return accountResult;

  let txFee = fee;
  if (!txFee) {
    const estimate = await fetchCongestionFeeEstimate(horizonUrl, parseInt(BASE_FEE, 10), undefined, networkConfig.network);
    txFee = estimate.recommendedFee;
  }

  try {
    const sourceAccount = new (await import("@stellar/stellar-sdk")).Account(account, accountResult.data.sequence);

    const builder = new TransactionBuilder(sourceAccount, {
      fee: txFee,
      networkPassphrase: networkConfig.networkPassphrase,
    });

    const setOptionsParams: Parameters<typeof Operation.setOptions>[0] = {
      signer: { ed25519PublicKey: recoveryKey, weight: recoveryWeight },
      lowThreshold,
      medThreshold,
      highThreshold,
    };

    if (masterWeight !== undefined) setOptionsParams.masterWeight = masterWeight;

    builder.addOperation(Operation.setOptions(setOptionsParams));
    builder.setTimeout(DEFAULT_TX_TIMEOUT_SECONDS);

    const tx = builder.build();

    return ok(tx.toXDR());
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Failed to build account recovery transaction: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    );
  }
}

export async function recoverAccountKeys(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  params: RecoverAccountKeysParams,
): Promise<SorokitResult<string>> {
  const {
    account,
    recoveryKey,
    compromisedKeys = [],
    newKeys,
    lowThreshold,
    medThreshold,
    highThreshold,
    masterWeight,
    fee,
  } = params;

  if (!isValidStellarPublicKey(account)) {
    return err(SorokitErrorCode.INVALID_ADDRESS, `Invalid account address: ${account}`);
  }
  if (!isValidStellarPublicKey(recoveryKey)) {
    return err(SorokitErrorCode.INVALID_ADDRESS, `Invalid recovery key address: ${recoveryKey}`);
  }
  for (const key of compromisedKeys) {
    if (!isValidStellarPublicKey(key)) {
      return err(SorokitErrorCode.INVALID_ADDRESS, `Invalid compromised key address: ${key}`);
    }
  }
  if (!Array.isArray(newKeys) || newKeys.length === 0) {
    return err(SorokitErrorCode.TX_BUILD_FAILED, "recoverAccountKeys: at least one replacement key is required in newKeys.");
  }

  const seenNewKeys = new Set<string>();
  for (const signer of newKeys) {
    if (!isValidStellarPublicKey(signer.key)) {
      return err(SorokitErrorCode.INVALID_ADDRESS, `Invalid new key address: ${signer.key}`);
    }
    if (!Number.isInteger(signer.weight) || signer.weight < 1 || signer.weight > 255) {
      return err(SorokitErrorCode.TX_BUILD_FAILED, `recoverAccountKeys: signer ${signer.key} has invalid weight ${signer.weight} — must be an integer between 1 and 255.`);
    }
    if (seenNewKeys.has(signer.key)) {
      return err(SorokitErrorCode.TX_BUILD_FAILED, `recoverAccountKeys: duplicate replacement key ${signer.key} in newKeys.`);
    }
    seenNewKeys.add(signer.key);
  }

  const compromisedSet = new Set(compromisedKeys);
  for (const signer of newKeys) {
    if (compromisedSet.has(signer.key)) {
      return err(SorokitErrorCode.TX_BUILD_FAILED, `recoverAccountKeys: key ${signer.key} cannot appear in both compromisedKeys and newKeys.`);
    }
  }

  for (const threshold of [lowThreshold, medThreshold, highThreshold]) {
    if (threshold !== undefined && (!Number.isInteger(threshold) || threshold < 0 || threshold > 255)) {
      return err(SorokitErrorCode.TX_BUILD_FAILED, `recoverAccountKeys: thresholds must be integers between 0 and 255.`);
    }
  }

  const accountResult = await getAccount(horizonUrl, account);
  if (accountResult.status === "error") return accountResult;

  const requestedThresholds = [lowThreshold, medThreshold, highThreshold].filter((t): t is number => t !== undefined);
  if (requestedThresholds.length > 0) {
    const maxRequestedThreshold = Math.max(...requestedThresholds);
    const installedWeight = newKeys.reduce((sum, s) => sum + s.weight, 0) + (masterWeight !== undefined ? masterWeight : 0);
    if (maxRequestedThreshold > installedWeight && masterWeight === undefined) {
      return err(SorokitErrorCode.TX_BUILD_FAILED, `recoverAccountKeys: requested threshold ${maxRequestedThreshold} exceeds the combined weight of the new signers (${installedWeight}) with no masterWeight override — this could lock the account out. Provide additional signers, a higher weight, or an explicit masterWeight.`);
    }
  }

  let txFee = fee;
  if (!txFee) {
    const estimate = await fetchCongestionFeeEstimate(horizonUrl, parseInt(BASE_FEE, 10), undefined, networkConfig.network);
    txFee = estimate.recommendedFee;
  }

  try {
    const sourceAccount = new (await import("@stellar/stellar-sdk")).Account(account, accountResult.data.sequence);

    const builder = new TransactionBuilder(sourceAccount, {
      fee: txFee,
      networkPassphrase: networkConfig.networkPassphrase,
    });

    for (const signer of newKeys) {
      builder.addOperation(
        Operation.setOptions({
          signer: { ed25519PublicKey: signer.key, weight: signer.weight },
        }),
      );
    }

    if (lowThreshold !== undefined || medThreshold !== undefined || highThreshold !== undefined || masterWeight !== undefined) {
      const setOptionsParams: Parameters<typeof Operation.setOptions>[0] = {};
      if (lowThreshold !== undefined) setOptionsParams.lowThreshold = lowThreshold;
      if (medThreshold !== undefined) setOptionsParams.medThreshold = medThreshold;
      if (highThreshold !== undefined) setOptionsParams.highThreshold = highThreshold;
      if (masterWeight !== undefined) setOptionsParams.masterWeight = masterWeight;
      builder.addOperation(Operation.setOptions(setOptionsParams));
    }

    for (const key of compromisedKeys) {
      builder.addOperation(
        Operation.setOptions({
          signer: { ed25519PublicKey: key, weight: 0 },
        }),
      );
    }

    builder.setTimeout(DEFAULT_TX_TIMEOUT_SECONDS);
    const tx = builder.build();

    return ok(tx.toXDR());
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Failed to build account recovery transaction: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    );
  }
}
