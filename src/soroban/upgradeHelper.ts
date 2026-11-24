// src/soroban/upgradeHelper.ts
import { ok, err, SorokitResult, SorokitErrorCode } from '../shared/response';
import { toMessage } from '../shared';
import {
  detectContractUpgrade,
  ContractUpgradeDetectionResult,
} from './upgradeDetection';
import {
  getContractVersion,
  compareVersions,
  ContractVersionInfo,
} from './contractVersion';
import {
  checkContractMetadataCompatibility,
  ContractMetadataCompatibilityResult,
} from './contractMetadataCompatibility';

/**
 * Represents a single step in a contract migration process.
 */
export interface MigrationStep {
  /** Ordering index of the step (0-based). */
  index: number;
  /** Short identifier for the step. */
  id: string;
  /** Human-readable description of what the step does. */
  description: string;
  /** Whether this step is required or optional. */
  required: boolean;
}

/**
 * Result of a compatibility check between two contract versions.
 */
export interface UpgradeCompatibilityResult {
  /** Whether the upgrade is compatible. */
  compatible: boolean;
  /** Human-readable summary of the compatibility result. */
  message: string;
  /** List of incompatibilities or warnings, if any. */
  issues: string[];
}

/**
 * Aggregated information about a contract upgrade.
 */
export interface UpgradeInfo {
  /** The contract identifier. */
  contractId: string;
  /** Whether the contract has been upgraded (code hash changed). */
  upgraded: boolean;
  /** The previous code hash, if known. */
  previousCodeHash?: string;
  /** The current code hash, if known. */
  currentCodeHash?: string;
  /** The previous version, if known. */
  previousVersion?: string;
  /** The current version, if known. */
  currentVersion?: string;
  /** Ordered migration steps to apply when upgrading. */
  migrationSteps: MigrationStep[];
  /** Compatibility result between old and new contracts, if evaluated. */
  compatibility?: UpgradeCompatibilityResult;
}

/**
 * Normalizes a code hash for comparison (trims and lowercases).
 */
function normalizeHash(hash: string | undefined | null): string {
  return (hash ?? '').trim().toLowerCase();
}

/**
 * Builds a standard set of migration steps for a version transition.
 */
function buildMigrationSteps(
  oldVersion: string,
  newVersion: string,
): MigrationStep[] {
  const steps: MigrationStep[] = [];
  let index = 0;

  const push = (id: string, description: string, required = true) => {
    steps.push({ index: index++, id, description, required });
  };

  push(
    'backup-state',
    `Back up on-chain state for version ${oldVersion} before upgrading to ${newVersion}.`,
  );
  push(
    'review-changes',
    `Review breaking changes between version ${oldVersion} and ${newVersion}.`,
  );
  push(
    'update-client',
    `Update client bindings and SDK usage to target version ${newVersion}.`,
  );
  push(
    'migrate-storage',
    'Migrate persistent storage entries to the new schema, if applicable.',
  );
  push(
    'verify-invariants',
    'Verify contract invariants and run integration tests against the new version.',
  );
  push(
    'deploy-upgrade',
    `Deploy the upgraded contract for version ${newVersion}.`,
  );
  push(
    'post-upgrade-check',
    'Perform post-upgrade smoke tests and confirm state integrity.',
    false,
  );

  return steps;
}

/**
 * Detects whether a contract has been upgraded by comparing its current
 * deployed code hash against a previously known hash.
 *
 * @param contractId The contract identifier.
 * @param oldHash The previously known code hash.
 * @returns A `SorokitResult` containing `UpgradeInfo`.
 */
export async function detectUpgrade(
  contractId: string,
  oldHash: string,
): Promise<SorokitResult<UpgradeInfo>> {
  try {
    if (!contractId || typeof contractId !== 'string') {
      return err(
        SorokitErrorCode.INVALID_ARGUMENT,
        'contractId must be a non-empty string',
      );
    }
    if (!oldHash || typeof oldHash !== 'string') {
      return err(
        SorokitErrorCode.INVALID_ARGUMENT,
        'oldHash must be a non-empty string',
      );
    }

    const detection: ContractUpgradeDetectionResult =
      await detectContractUpgrade(contractId);

    const currentHash = normalizeHash(detection?.currentCodeHash);
    const previousHash = normalizeHash(oldHash);
    const upgraded = currentHash !== '' && currentHash !== previousHash;

    const info: UpgradeInfo = {
      contractId,
      upgraded,
      previousCodeHash: oldHash,
      currentCodeHash: detection?.currentCodeHash,
      previousVersion: detection?.previousVersion,
      currentVersion: detection?.currentVersion,
      migrationSteps: [],
    };

    return ok(info);
  } catch (error) {
    return err(
      SorokitErrorCode.UNKNOWN_ERROR,
      `Failed to detect upgrade: ${toMessage(error)}`,
    );
  }
}

/**
 * Produces ordered migration steps for moving a contract from an old version
 * to a new version, using version metadata where available.
 *
 * @param contractId The contract identifier.
 * @param oldVersion The current/old version string.
 * @param newVersion The target/new version string.
 * @returns A `SorokitResult` containing `UpgradeInfo` with migration steps.
 */
export async function getMigrationSteps(
  contractId: string,
  oldVersion: string,
  newVersion: string,
): Promise<SorokitResult<UpgradeInfo>> {
  try {
    if (!contractId || typeof contractId !== 'string') {
      return err(
        SorokitErrorCode.INVALID_ARGUMENT,
        'contractId must be a non-empty string',
      );
    }
    if (!oldVersion || typeof oldVersion !== 'string') {
      return err(
        SorokitErrorCode.INVALID_ARGUMENT,
        'oldVersion must be a non-empty string',
      );
    }
    if (!newVersion || typeof newVersion !== 'string') {
      return err(
        SorokitErrorCode.INVALID_ARGUMENT,
        'newVersion must be a non-empty string',
      );
    }

    let versionInfo: ContractVersionInfo | undefined;
    try {
      versionInfo = await getContractVersion(contractId);
    } catch {
      // Version metadata is optional; proceed with provided versions.
      versionInfo = undefined;
    }

    const comparison = compareVersions(oldVersion, newVersion);
    if (comparison > 0) {
      return err(
        SorokitErrorCode.INVALID_ARGUMENT,
        `Target version ${newVersion} is older than current version ${oldVersion}`,
      );
    }

    const migrationSteps = buildMigrationSteps(oldVersion, newVersion);

    const info: UpgradeInfo = {
      contractId,
      upgraded: comparison !== 0,
      previousVersion: oldVersion,
      currentVersion: newVersion,
      previousCodeHash: versionInfo?.codeHash,
      currentCodeHash: versionInfo?.codeHash,
      migrationSteps,
    };

    return ok(info);
  } catch (error) {
    return err(
      SorokitErrorCode.UNKNOWN_ERROR,
      `Failed to build migration steps: ${toMessage(error)}`,
    );
  }
}

/**
 * Validates whether an upgrade from an old contract to a new contract is
 * compatible, delegating to the metadata compatibility checker.
 *
 * @param oldContract The old contract descriptor (metadata or identifier).
 * @param newContract The new contract descriptor (metadata or identifier).
 * @returns A `SorokitResult` containing `UpgradeInfo` with compatibility info.
 */
export async function validateUpgradeCompatibility(
  oldContract: unknown,
  newContract: unknown,
): Promise<SorokitResult<UpgradeInfo>> {
  try {
    if (oldContract === undefined || oldContract === null) {
      return err(
        SorokitErrorCode.INVALID_ARGUMENT,
        'oldContract must be provided',
      );
    }
    if (newContract === undefined || newContract === null) {
      return err(
        SorokitErrorCode.INVALID_ARGUMENT,
        'newContract must be provided',
      );
    }

    const result: ContractMetadataCompatibilityResult =
      await checkContractMetadataCompatibility(oldContract, newContract);

    const issues: string[] = Array.isArray(result?.issues)
      ? result.issues.map((issue) => String(issue))
      : [];

    const compatibility: UpgradeCompatibilityResult = {
      compatible: Boolean(result?.compatible),
      message:
        result?.message ??
        (result?.compatible
          ? 'Contracts are compatible for upgrade.'
          : 'Contracts are not compatible for upgrade.'),
      issues,
    };

    const contractId =
      typeof (newContract as { contractId?: unknown })?.contractId === 'string'
        ? ((newContract as { contractId: string }).contractId)
        : typeof (oldContract as { contractId?: unknown })?.contractId ===
            'string'
          ? ((oldContract as { contractId: string }).contractId)
          : '';

    const info: UpgradeInfo = {
      contractId,
      upgraded: false,
      migrationSteps: [],
      compatibility,
    };

    return ok(info);
  } catch (error) {
    return err(
      SorokitErrorCode.UNKNOWN_ERROR,
      `Failed to validate upgrade compatibility: ${toMessage(error)}`,
    );
  }
}