import { StrKey, Operation, TransactionBuilder, BASE_FEE } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { ResolvedNetworkConfig } from "../shared/types";
import { DEFAULT_TX_TIMEOUT_SECONDS } from "../shared/constants";
import { getAccount } from "./getAccount";
import { createHorizonServer } from "../shared/serverFactory";
import { toMessage } from "../shared/errors";

/**
 * Options/Params for rotating an account key.
 */
export interface RotateAccountKeyParams {
  /** Account object or public key string (G-address) */
  account: string;
  /** Current signer public key (G-address) to remove */
  oldKey: string;
  /** New signer public key (G-address) to add */
  newKey: string;
  /** Weight for the new key (default: 1) */
  newKeyWeight?: number;
}

/**
 * Options/Params for setting account recovery signers and thresholds.
 */
export interface SetAccountRecoveryParams {
  /** Account object or public key string (G-address) */
  account: string;
  /** Recovery signer public key (G-address) to add */
  recoveryKey: string;
  /** Weight for the recovery key (default: 1) */
  recoveryWeight?: number;
  /** Master key weight (optional) */
  masterWeight?: number;
  /** Low threshold for low-security operations (default: 1) */
  lowThreshold?: number;
  /** Medium threshold for standard operations (default: 2) */
  medThreshold?: number;
  /** High threshold for high-security operations (default: 2) */
  highThreshold?: number;
}

/**
 * Helper to validate a Stellar public key (G-address).
 */
export function isValidStellarPublicKey(key: string): boolean {
  if (typeof key !== "string") return false;
  return StrKey.isValidEd25519PublicKey(key);
}

// ─── Account key recovery (issue #401) ────────────────────────────────────────

/** A replacement signer to add during account key recovery. */
export interface RecoveryNewKey {
  /** New signer public key (G-address) to add. */
  publicKey: string;
  /** Signing weight for the new key (default: 1). */
  weight?: number;
}

/**
 * Options/Params for recovering account keys via a designated recovery signer.
 */
export interface RecoverAccountKeysParams {
  /** Account object or public key string (G-address) whose keys are being recovered. */
  account: string;
  /**
   * Recovery signer public key (G-address). Must currently be a signer on
   * the account (e.g. set up in advance via {@link setAccountRecovery}).
   */
  recoveryKey: string;
  /** New signer(s) to add in place of the compromised/unavailable key(s). */
  newKeys: RecoveryNewKey[];
  /**
   * Existing signer public key(s) to remove (the compromised or
   * unavailable keys being replaced). May be empty to add new signers
   * without removing any existing ones.
   */
  compromisedKeys?: string[];
  /**
   * Optional new thresholds to set as part of recovery. When omitted, the
   * account's current thresholds are preserved unchanged.
   */
  lowThreshold?: number;
  medThreshold?: number;
  highThreshold?: number;
}

/**
 * Recover account signing keys using a pre-configured recovery signer.
 *
 * Constructs (but does not submit or sign) a transaction that adds each key
 * in `newKeys` and removes each key in `compromisedKeys`, in a safe order —
 * new keys are added before old ones are removed, so the account is never
 * left without a signer that meets its own thresholds mid-transaction.
 *
 * This is a template only: the caller is responsible for collecting the
 * signatures required to meet the account's current `highThreshold` (recovery
 * operations are `setOptions`, which always requires high-threshold weight)
 * before submitting — see `buildMultiSigEnvelope`/`collectSignature` in
 * `transaction/multiSig.ts` for multi-signature recovery.
 *
 * Safety considerations:
 * - Validates the account, recovery key, and every new/compromised key format.
 * - Requires the recovery key to currently be a signer on the account.
 * - Rejects a recovery that would remove the recovery key itself (it must
 *   remain available to co-sign, or a subsequent recovery becomes impossible).
 * - Rejects a recovery that would drop total signer weight below the
 *   account's current (or newly requested) high threshold, which would
 *   otherwise unintentionally lock the account out of high-security operations.
 * - Rejects a recovery that would leave the account with zero signers of
 *   nonzero weight.
 *
 * @param horizonUrl Base URL of Horizon server
 * @param networkConfig Resolved network configuration
 * @param params Recovery parameters — recovery key, new keys, and keys to remove
 * @returns `ok(transactionXdr)` — an unsigned transaction template ready for
 *   review and signing — or an error describing why recovery was rejected.
 *
 * @example
 * const result = await recoverAccountKeys(horizonUrl, networkConfig, {
 *   account: "GACCOUNT...",
 *   recoveryKey: "GRECOVERY...",
 *   compromisedKeys: ["GCOMPROMISED..."],
 *   newKeys: [{ publicKey: "GNEWKEY...", weight: 1 }],
 * });
 * if (result.status === "ok") {
 *   // Review result.data (the transaction XDR), then collect the required
 *   // signatures (e.g. via buildMultiSigEnvelope) before submitting.
 * }
 */
export async function recoverAccountKeys(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  params: RecoverAccountKeysParams,
): Promise<SorokitResult<string>> {
  const { account, recoveryKey, newKeys, compromisedKeys = [] } = params;

  if (!isValidStellarPublicKey(account)) {
    return err(SorokitErrorCode.INVALID_ADDRESS, `Invalid account address: ${account}`);
  }
  if (!isValidStellarPublicKey(recoveryKey)) {
    return err(SorokitErrorCode.INVALID_ADDRESS, `Invalid recovery key address: ${recoveryKey}`);
  }
  if (!newKeys || newKeys.length === 0) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "recoverAccountKeys: at least one new key is required.",
    );
  }
  for (const newKey of newKeys) {
    if (!isValidStellarPublicKey(newKey.publicKey)) {
      return err(
        SorokitErrorCode.INVALID_ADDRESS,
        `Invalid new key address: ${newKey.publicKey}`,
      );
    }
    if (newKey.weight !== undefined && newKey.weight < 0) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        `recoverAccountKeys: new key ${newKey.publicKey} has invalid weight ${newKey.weight} — must be >= 0.`,
      );
    }
  }
  for (const compromisedKey of compromisedKeys) {
    if (!isValidStellarPublicKey(compromisedKey)) {
      return err(
        SorokitErrorCode.INVALID_ADDRESS,
        `Invalid compromised key address: ${compromisedKey}`,
      );
    }
  }
  if (compromisedKeys.includes(recoveryKey)) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "recoverAccountKeys: the recovery key cannot be listed as a compromised key — it must remain available to authorize this and any future recovery.",
    );
  }
  const newKeyAddresses = new Set(newKeys.map((k) => k.publicKey));
  for (const compromisedKey of compromisedKeys) {
    if (newKeyAddresses.has(compromisedKey)) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        `recoverAccountKeys: key ${compromisedKey} cannot be listed as both a new key and a compromised key.`,
      );
    }
  }

  let horizonAccount;
  try {
    const server = createHorizonServer(horizonUrl);
    horizonAccount = await server.loadAccount(account);
  } catch (cause) {
    return err(
      SorokitErrorCode.ACCOUNT_FETCH_FAILED,
      `recoverAccountKeys: failed to load account ${account}: ${toMessage(cause)}`,
      cause,
    );
  }

  const currentSigners = new Map(
    horizonAccount.signers.map((s) => [s.key, s.weight]),
  );

  if (!currentSigners.has(recoveryKey) || (currentSigners.get(recoveryKey) ?? 0) <= 0) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `recoverAccountKeys: ${recoveryKey} is not currently an active signer on ${account}. Configure it first via setAccountRecovery().`,
    );
  }

  for (const compromisedKey of compromisedKeys) {
    if (!currentSigners.has(compromisedKey) || (currentSigners.get(compromisedKey) ?? 0) <= 0) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        `recoverAccountKeys: ${compromisedKey} is not currently an active signer on ${account} — nothing to recover.`,
      );
    }
  }

  const highThreshold = params.highThreshold ?? horizonAccount.thresholds.high_threshold;
  const medThreshold = params.medThreshold ?? horizonAccount.thresholds.med_threshold;
  const lowThreshold = params.lowThreshold ?? horizonAccount.thresholds.low_threshold;

  // Simulate the resulting signer set (master key weight is a "signer" too,
  // keyed by the account address itself in Horizon's signers list) to
  // ensure recovery cannot unintentionally lock the account out.
  const resultingWeights = new Map(currentSigners);
  for (const compromisedKey of compromisedKeys) {
    resultingWeights.set(compromisedKey, 0);
  }
  for (const newKey of newKeys) {
    resultingWeights.set(newKey.publicKey, newKey.weight ?? 1);
  }

  const resultingTotalWeight = Array.from(resultingWeights.values()).reduce(
    (sum, w) => sum + w,
    0,
  );

  if (resultingTotalWeight <= 0) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "recoverAccountKeys: the requested change would leave the account with zero total signer weight, which would permanently lock it. Recovery rejected.",
    );
  }
  if (resultingTotalWeight < highThreshold) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `recoverAccountKeys: the requested change would leave total signer weight (${resultingTotalWeight}) below the account's high threshold (${highThreshold}), which would lock the account out of high-security operations. Recovery rejected.`,
    );
  }

  try {
    const sourceAccount = new (await import("@stellar/stellar-sdk")).Account(
      account,
      horizonAccount.sequence,
    );

    const builder = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: networkConfig.networkPassphrase,
    });

    // 1. Add every new key first, so the account always has a valid
    //    superset of signers before any existing key is removed.
    for (const newKey of newKeys) {
      builder.addOperation(
        Operation.setOptions({
          signer: {
            ed25519PublicKey: newKey.publicKey,
            weight: newKey.weight ?? 1,
          },
        }),
      );
    }

    // 2. Update thresholds, if requested, after new keys are in place and
    //    before old keys are removed.
    if (
      params.lowThreshold !== undefined ||
      params.medThreshold !== undefined ||
      params.highThreshold !== undefined
    ) {
      builder.addOperation(
        Operation.setOptions({ lowThreshold, medThreshold, highThreshold }),
      );
    }

    // 3. Remove compromised/unavailable keys last (weight 0 removes a signer).
    for (const compromisedKey of compromisedKeys) {
      builder.addOperation(
        Operation.setOptions({
          signer: { ed25519PublicKey: compromisedKey, weight: 0 },
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

/**
 * Rotate an account key by adding a new signer and removing an old signer in a safe sequence.
 *
 * Safety considerations:
 * - Validates format of all keys.
 * - Ensures oldKey and newKey are not identical.
 * - Adds the new key before removing the old key in the operation sequence so the account is never left without signers.
 *
 * @param horizonUrl Base URL of Horizon server
 * @param networkConfig Resolved network configuration
 * @param params Rotate account key options
 * @returns ok(xdr) or error
 */
export async function rotateAccountKey(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  params: RotateAccountKeyParams,
): Promise<SorokitResult<string>> {
  const { account, oldKey, newKey, newKeyWeight = 1 } = params;

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
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "Old key and new key cannot be identical.",
    );
  }

  const accountResult = await getAccount(horizonUrl, account);
  if (accountResult.status === "error") {
    return accountResult;
  }

  try {
    const sourceAccount = new (await import("@stellar/stellar-sdk")).Account(
      account,
      accountResult.data.sequence,
    );

    const builder = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: networkConfig.networkPassphrase,
    });

    // 1. Add new key first (safely ensures account retains valid signer)
    builder.addOperation(
      Operation.setOptions({
        signer: {
          ed25519PublicKey: newKey,
          weight: newKeyWeight,
        },
      }),
    );

    // 2. Remove old key (setting weight to 0 removes signer)
    builder.addOperation(
      Operation.setOptions({
        signer: {
          ed25519PublicKey: oldKey,
          weight: 0,
        },
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

/**
 * Configure account recovery by adding a recovery signer key and updating thresholds.
 *
 * Safety considerations:
 * - Validates key formats.
 * - Sets thresholds and recovery signer in a safe single transaction.
 *
 * @param horizonUrl Base URL of Horizon server
 * @param networkConfig Resolved network configuration
 * @param params Set account recovery options
 * @returns ok(xdr) or error
 */
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
  } = params;

  if (!isValidStellarPublicKey(account)) {
    return err(SorokitErrorCode.INVALID_ADDRESS, `Invalid account address: ${account}`);
  }
  if (!isValidStellarPublicKey(recoveryKey)) {
    return err(SorokitErrorCode.INVALID_ADDRESS, `Invalid recovery key address: ${recoveryKey}`);
  }

  const accountResult = await getAccount(horizonUrl, account);
  if (accountResult.status === "error") {
    return accountResult;
  }

  try {
    const sourceAccount = new (await import("@stellar/stellar-sdk")).Account(
      account,
      accountResult.data.sequence,
    );

    const builder = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: networkConfig.networkPassphrase,
    });

    const setOptionsParams: Parameters<typeof Operation.setOptions>[0] = {
      signer: {
        ed25519PublicKey: recoveryKey,
        weight: recoveryWeight,
      },
      lowThreshold,
      medThreshold,
      highThreshold,
    };

    if (masterWeight !== undefined) {
      setOptionsParams.masterWeight = masterWeight;
    }

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
