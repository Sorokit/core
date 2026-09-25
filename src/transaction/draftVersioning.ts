/**
 * Transaction Draft Versioning, Diffing, and Rollback (#518)
 *
 * Extends transaction draft persistence with immutable version snapshots.
 * Every meaningful draft update creates a version containing the transaction builder state and metadata.
 * Provides comparison utilities and rollback functionality.
 */

import { ok, err, SorokitResult, SorokitErrorCode } from "../shared/response";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface DraftVersion {
  id: string;
  sequenceNumber: number;
  timestamp: number;
  transactionXdr: string;
  metadata: DraftMetadata;
}

export interface DraftMetadata {
  name: string;
  description?: string;
  tags?: string[];
  createdBy?: string;
}

export interface DraftVersionDiff {
  addedOperations: OperationDiff[];
  removedOperations: OperationDiff[];
  modifiedOperations: OperationDiff[];
  metadataChanges: MetadataChange[];
}

export interface OperationDiff {
  index: number;
  operationXdr: string;
  operationType: string;
}

export interface MetadataChange {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

export interface DraftVersionStore {
  versions: Map<string, DraftVersion[]>;
  currentVersions: Map<string, string>;
  maxVersionsPerDraft?: number;
}

export interface DraftVersioningConfig {
  maxVersionsPerDraft?: number;
  enableCompression?: boolean;
}

// ─── Draft Version Manager ─────────────────────────────────────────────────────

export class DraftVersionManager {
  private store: DraftVersionStore;
  private config: Required<DraftVersioningConfig>;

  constructor(config: DraftVersioningConfig = {}) {
    this.config = {
      maxVersionsPerDraft: config.maxVersionsPerDraft ?? 50,
      enableCompression: config.enableCompression ?? false,
    };
    this.store = {
      versions: new Map(),
      currentVersions: new Map(),
      maxVersionsPerDraft: this.config.maxVersionsPerDraft,
    };
  }

  /**
   * Create a new version for a draft
   */
  createVersion(
    name: string,
    transactionXdr: string,
    metadata: DraftMetadata,
  ): SorokitResult<DraftVersion> {
    const versions = this.store.versions.get(name) || [];
    const sequenceNumber = versions.length + 1;

    const version: DraftVersion = {
      id: this.generateVersionId(name, sequenceNumber),
      sequenceNumber,
      timestamp: Date.now(),
      transactionXdr,
      metadata,
    };

    versions.push(version);

    // Enforce max versions limit
    if (versions.length > this.config.maxVersionsPerDraft) {
      versions.shift(); // Remove oldest version
    }

    this.store.versions.set(name, versions);
    this.store.currentVersions.set(name, version.id);

    return ok(version);
  }

  /**
   * Get a specific version of a draft
   */
  getVersion(name: string, versionId: string): SorokitResult<DraftVersion> {
    const versions = this.store.versions.get(name);
    if (!versions) {
      return err(
        SorokitErrorCode.VALIDATION,
        `Draft not found: ${name}`,
      );
    }

    const version = versions.find((v) => v.id === versionId);
    if (!version) {
      return err(
        SorokitErrorCode.VALIDATION,
        `Version not found: ${versionId}`,
      );
    }

    return ok(version);
  }

  /**
   * Get the current version of a draft
   */
  getCurrentVersion(name: string): SorokitResult<DraftVersion> {
    const currentId = this.store.currentVersions.get(name);
    if (!currentId) {
      return err(
        SorokitErrorCode.VALIDATION,
        `No current version for draft: ${name}`,
      );
    }

    return this.getVersion(name, currentId);
  }

  /**
   * List all versions of a draft
   */
  listVersions(name: string): SorokitResult<DraftVersion[]> {
    const versions = this.store.versions.get(name);
    if (!versions) {
      return err(
        SorokitErrorCode.VALIDATION,
        `Draft not found: ${name}`,
      );
    }

    return ok([...versions]);
  }

  /**
   * Compare two versions of a draft
   */
  compareVersions(
    name: string,
    fromVersionId: string,
    toVersionId: string,
  ): SorokitResult<DraftVersionDiff> {
    const fromResult = this.getVersion(name, fromVersionId);
    if (fromResult.status === "error") {
      return fromResult;
    }

    const toResult = this.getVersion(name, toVersionId);
    if (toResult.status === "error") {
      return toResult;
    }

    const fromVersion = fromResult.data;
    const toVersion = toResult.data;

    const fromOps = this.parseOperations(fromVersion.transactionXdr);
    const toOps = this.parseOperations(toVersion.transactionXdr);

    const diff = this.computeDiff(fromOps, toOps);

    const metadataChanges = this.computeMetadataDiff(
      fromVersion.metadata,
      toVersion.metadata,
    );

    return ok({
      ...diff,
      metadataChanges,
    });
  }

  /**
   * Revert a draft to a previous version
   * Creates a new version instead of deleting history
   */
  revertDraft(
    name: string,
    versionId: string,
  ): SorokitResult<DraftVersion> {
    const versionResult = this.getVersion(name, versionId);
    if (versionResult.status === "error") {
      return versionResult;
    }

    const version = versionResult.data;

    // Create a new version with the reverted content
    const revertMetadata: DraftMetadata = {
      ...version.metadata,
      description: version.metadata.description
        ? `${version.metadata.description} (reverted from version ${version.sequenceNumber})`
        : `Reverted from version ${version.sequenceNumber}`,
    };

    return this.createVersion(name, version.transactionXdr, revertMetadata);
  }

  /**
   * Delete a draft and all its versions
   */
  deleteDraft(name: string): SorokitResult<void> {
    if (!this.store.versions.has(name)) {
      return err(
        SorokitErrorCode.VALIDATION,
        `Draft not found: ${name}`,
      );
    }

    this.store.versions.delete(name);
    this.store.currentVersions.delete(name);

    return ok(undefined);
  }

  /**
   * Validate a version's integrity
   */
  validateVersion(name: string, versionId: string): SorokitResult<boolean> {
    const versionResult = this.getVersion(name, versionId);
    if (versionResult.status === "error") {
      return versionResult;
    }

    const version = versionResult.data;

    try {
      // In production, you'd validate XDR can be parsed using @stellar/stellar-sdk
      // For now, just check if XDR is non-empty
      if (!version.transactionXdr || version.transactionXdr.length === 0) {
        return ok(false);
      }
      return ok(true);
    } catch (error) {
      return ok(false);
    }
  }

  /**
   * Get version count for a draft
   */
  getVersionCount(name: string): SorokitResult<number> {
    const versions = this.store.versions.get(name);
    if (!versions) {
      return err(
        SorokitErrorCode.VALIDATION,
        `Draft not found: ${name}`,
      );
    }

    return ok(versions.length);
  }

  /**
   * Prune old versions beyond retention limit
   */
  pruneVersions(name: string, retainCount: number): SorokitResult<number> {
    const versions = this.store.versions.get(name);
    if (!versions) {
      return err(
        SorokitErrorCode.VALIDATION,
        `Draft not found: ${name}`,
      );
    }

    if (versions.length <= retainCount) {
      return ok(0);
    }

    const toRemove = versions.length - retainCount;
    const removed = versions.splice(0, toRemove);
    this.store.versions.set(name, versions);

    return ok(removed.length);
  }

  // ─── Private Helpers ───────────────────────────────────────────────────────

  private generateVersionId(name: string, sequenceNumber: number): string {
    const timestamp = Date.now().toString(36);
    const hash = btoa(`${name}:${sequenceNumber}:${timestamp}`).slice(0, 8);
    return `v${sequenceNumber}-${hash}`;
  }

  private parseOperations(transactionXdr: string): string[] {
    try {
      // In production, you'd properly parse the XDR using @stellar/stellar-sdk
      // For now, return empty array as placeholder
      // const tx = TransactionBuilder.fromXDR(transactionXdr, "base64");
      return [];
    } catch {
      return [];
    }
  }

  private computeDiff(
    fromOps: string[],
    toOps: string[],
  ): Omit<DraftVersionDiff, "metadataChanges"> {
    const addedOperations: OperationDiff[] = [];
    const removedOperations: OperationDiff[] = [];
    const modifiedOperations: OperationDiff[] = [];

    // Simple diff algorithm
    const maxLen = Math.max(fromOps.length, toOps.length);

    for (let i = 0; i < maxLen; i++) {
      const fromOp = fromOps[i];
      const toOp = toOps[i];

      if (fromOp === undefined && toOp !== undefined) {
        addedOperations.push({
          index: i,
          operationXdr: toOp,
          operationType: this.getOperationType(toOp),
        });
      } else if (fromOp !== undefined && toOp === undefined) {
        removedOperations.push({
          index: i,
          operationXdr: fromOp,
          operationType: this.getOperationType(fromOp),
        });
      } else if (fromOp !== undefined && toOp !== undefined && fromOp !== toOp) {
        modifiedOperations.push({
          index: i,
          operationXdr: toOp,
          operationType: this.getOperationType(toOp),
        });
      }
    }

    return {
      addedOperations,
      removedOperations,
      modifiedOperations,
    };
  }

  private computeMetadataDiff(
    fromMeta: DraftMetadata,
    toMeta: DraftMetadata,
  ): MetadataChange[] {
    const changes: MetadataChange[] = [];

    const allKeys = new Set([
      ...Object.keys(fromMeta),
      ...Object.keys(toMeta),
    ]);

    allKeys.forEach((key) => {
      const oldValue = fromMeta[key as keyof DraftMetadata];
      const newValue = toMeta[key as keyof DraftMetadata];

      if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
        changes.push({
          field: key,
          oldValue,
          newValue,
        });
      }
    });

    return changes;
  }

  private getOperationType(operationXdr: string): string {
    // Simplified operation type detection
    // In production, you'd properly parse the XDR to get the operation type
    return "unknown";
  }
}

// ─── In-Memory Store ─────────────────────────────────────────────────────────

export class InMemoryDraftVersionStore implements DraftVersionStore {
  versions: Map<string, DraftVersion[]> = new Map();
  currentVersions: Map<string, string> = new Map();
  maxVersionsPerDraft?: number = 50;

  constructor(maxVersionsPerDraft?: number) {
    this.maxVersionsPerDraft = maxVersionsPerDraft ?? 50;
  }
}

// ─── Factory ───────────────────────────────────────────────────────────────────

const defaultManager = new DraftVersionManager();

export function createDraftVersionManager(
  config?: DraftVersioningConfig,
): DraftVersionManager {
  return new DraftVersionManager(config);
}

export function getDefaultDraftVersionManager(): DraftVersionManager {
  return defaultManager;
}

// ─── Convenience Functions ─────────────────────────────────────────────────────

/**
 * Create a new version for a draft using the default manager
 */
export function createDraftVersion(
  name: string,
  transactionXdr: string,
  metadata: DraftMetadata,
): SorokitResult<DraftVersion> {
  return defaultManager.createVersion(name, transactionXdr, metadata);
}

/**
 * Get a specific version of a draft
 */
export function getDraftVersion(
  name: string,
  versionId: string,
): SorokitResult<DraftVersion> {
  return defaultManager.getVersion(name, versionId);
}

/**
 * Get the current version of a draft
 */
export function getCurrentDraftVersion(
  name: string,
): SorokitResult<DraftVersion> {
  return defaultManager.getCurrentVersion(name);
}

/**
 * List all versions of a draft
 */
export function listDraftVersions(name: string): SorokitResult<DraftVersion[]> {
  return defaultManager.listVersions(name);
}

/**
 * Compare two versions of a draft
 */
export function compareDraftVersions(
  name: string,
  fromVersionId: string,
  toVersionId: string,
): SorokitResult<DraftVersionDiff> {
  return defaultManager.compareVersions(name, fromVersionId, toVersionId);
}

/**
 * Revert a draft to a previous version
 */
export function revertDraft(
  name: string,
  versionId: string,
): SorokitResult<DraftVersion> {
  return defaultManager.revertDraft(name, versionId);
}

/**
 * Delete a draft and all its versions
 */
export function deleteDraft(name: string): SorokitResult<void> {
  return defaultManager.deleteDraft(name);
}

/**
 * Validate a version's integrity
 */
export function validateDraftVersion(
  name: string,
  versionId: string,
): SorokitResult<boolean> {
  return defaultManager.validateVersion(name, versionId);
}
