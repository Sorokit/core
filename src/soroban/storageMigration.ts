/**
 * Soroban Contract Storage Migration Framework with Rollback (#519)
 *
 * Creates a versioned storage migration framework.
 * A migration defines a source schema/version, target schema/version, transformation function,
 * validation step, and rollback strategy.
 */

import { ok, err, SorokitResult, SorokitErrorCode } from "../shared/response";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface StorageVersion {
  schema: string;
  version: string;
}

export interface StorageMigration {
  id: string;
  source: StorageVersion;
  target: StorageVersion;
  transform: (data: unknown) => SorokitResult<unknown>;
  validatePreMigration?: (data: unknown) => SorokitResult<void>;
  validatePostMigration?: (data: unknown) => SorokitResult<void>;
  rollback?: (data: unknown) => SorokitResult<unknown>;
  description?: string;
}

export interface MigrationStatus {
  migrationId: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "rolled_back";
  timestamp: number;
  error?: string | undefined;
}

export interface MigrationResult {
  success: boolean;
  migratedData: unknown;
  status: MigrationStatus;
  rollbackData?: unknown;
}

export interface MigrationRegistry {
  migrations: Map<string, StorageMigration>;
  status: Map<string, MigrationStatus>;
}

export interface MigrationConfig {
  enableAutoRollback?: boolean;
  maxRetries?: number;
  persistStatus?: boolean;
}

// ─── Storage Migration Manager ─────────────────────────────────────────────────

export class StorageMigrationManager {
  private registry: MigrationRegistry;
  private config: Required<MigrationConfig>;

  constructor(config: MigrationConfig = {}) {
    this.config = {
      enableAutoRollback: config.enableAutoRollback ?? true,
      maxRetries: config.maxRetries ?? 3,
      persistStatus: config.persistStatus ?? true,
    };
    this.registry = {
      migrations: new Map(),
      status: new Map(),
    };
  }

  /**
   * Register a migration
   */
  registerMigration(migration: StorageMigration): SorokitResult<void> {
    if (this.registry.migrations.has(migration.id)) {
      return err(
        SorokitErrorCode.VALIDATION,
        `Migration already registered: ${migration.id}`,
      );
    }

    // Validate migration structure
    const validation = this.validateMigration(migration);
    if (validation.status === "error") {
      return validation;
    }

    this.registry.migrations.set(migration.id, migration);
    this.registry.status.set(migration.id, {
      migrationId: migration.id,
      status: "pending",
      timestamp: Date.now(),
    });

    return ok(undefined);
  }

  /**
   * Get a registered migration
   */
  getMigration(id: string): SorokitResult<StorageMigration> {
    const migration = this.registry.migrations.get(id);
    if (!migration) {
      return err(
        SorokitErrorCode.VALIDATION,
        `Migration not found: ${id}`,
      );
    }

    return ok(migration);
  }

  /**
   * Get migration status
   */
  getMigrationStatus(id: string): SorokitResult<MigrationStatus> {
    const status = this.registry.status.get(id);
    if (!status) {
      return err(
        SorokitErrorCode.VALIDATION,
        `Migration status not found: ${id}`,
      );
    }

    return ok(status);
  }

  /**
   * List all registered migrations
   */
  listMigrations(): StorageMigration[] {
    return Array.from(this.registry.migrations.values());
  }

  /**
   * Apply a migration to data
   */
  async applyMigration(
    migrationId: string,
    data: unknown,
  ): Promise<SorokitResult<MigrationResult>> {
    const migrationResult = this.getMigration(migrationId);
    if (migrationResult.status === "error") {
      return migrationResult;
    }

    const migration = migrationResult.data;

    // Check if migration already completed
    const statusResult = this.getMigrationStatus(migrationId);
    if (statusResult.status === "ok" && statusResult.data.status === "completed") {
      return err(
        SorokitErrorCode.VALIDATION,
        `Migration already completed: ${migrationId}`,
      );
    }

    // Update status to in_progress
    this.updateStatus(migrationId, "in_progress");

    // Pre-migration validation
    if (migration.validatePreMigration) {
      const preValidation = migration.validatePreMigration(data);
      if (preValidation.status === "error") {
        this.updateStatus(migrationId, "failed", preValidation.error.message);
        return err(
          SorokitErrorCode.VALIDATION,
          `Pre-migration validation failed: ${preValidation.error.message}`,
        );
      }
    }

    // Transform data with retries
    let transformedData: unknown;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      const transformResult = migration.transform(data);
      if (transformResult.status === "ok") {
        transformedData = transformResult.data;
        break;
      }

      lastError = transformResult.error.cause as Error;
      if (attempt === this.config.maxRetries - 1) {
        this.updateStatus(migrationId, "failed", lastError?.message);
        return err(
          SorokitErrorCode.INTERNAL,
          `Migration transformation failed after ${this.config.maxRetries} attempts`,
          lastError,
        );
      }

      // Exponential backoff
      await this.delay(Math.pow(2, attempt) * 100);
    }

    // Post-migration validation
    if (migration.validatePostMigration) {
      const postValidation = migration.validatePostMigration(transformedData);
      if (postValidation.status === "error") {
        this.updateStatus(migrationId, "failed", postValidation.error.message);
        
        // Auto-rollback if enabled
        if (this.config.enableAutoRollback && migration.rollback) {
          const rollbackResult = await this.performRollback(migrationId, data);
          if (rollbackResult.status === "error") {
            return err(
              SorokitErrorCode.INTERNAL,
              `Post-migration validation failed and rollback also failed: ${rollbackResult.error.message}`,
            );
          }
        }

        return err(
          SorokitErrorCode.VALIDATION,
          `Post-migration validation failed: ${postValidation.error.message}`,
        );
      }
    }

    // Update status to completed
    this.updateStatus(migrationId, "completed");

    return ok({
      success: true,
      migratedData: transformedData,
      status: this.registry.status.get(migrationId)!,
      rollbackData: data,
    });
  }

  /**
   * Rollback a migration
   */
  async rollbackMigration(
    migrationId: string,
    data: unknown,
  ): Promise<SorokitResult<unknown>> {
    const migrationResult = this.getMigration(migrationId);
    if (migrationResult.status === "error") {
      return migrationResult;
    }

    const migration = migrationResult.data;

    if (!migration.rollback) {
      return err(
        SorokitErrorCode.VALIDATION,
        `Migration does not support rollback: ${migrationId}`,
      );
    }

    return this.performRollback(migrationId, data);
  }

  /**
   * Perform the actual rollback
   */
  private async performRollback(
    migrationId: string,
    data: unknown,
  ): Promise<SorokitResult<unknown>> {
    const migrationResult = this.getMigration(migrationId);
    if (migrationResult.status === "error") {
      return migrationResult;
    }

    const migration = migrationResult.data;

    if (!migration.rollback) {
      return err(
        SorokitErrorCode.VALIDATION,
        `Rollback not supported for migration: ${migrationId}`,
      );
    }

    this.updateStatus(migrationId, "in_progress");

    const rollbackResult = migration.rollback(data);
    if (rollbackResult.status === "error") {
      this.updateStatus(migrationId, "failed", rollbackResult.error.message);
      return rollbackResult;
    }

    this.updateStatus(migrationId, "rolled_back");
    return rollbackResult;
  }

  /**
   * Check if a migration can be applied
   */
  canApplyMigration(migrationId: string): SorokitResult<boolean> {
    const statusResult = this.getMigrationStatus(migrationId);
    if (statusResult.status === "error") {
      return ok(false);
    }

    const status = statusResult.data;
    return ok(status.status === "pending" || status.status === "failed");
  }

  /**
   * Reset migration status (for testing or retry)
   */
  resetMigrationStatus(migrationId: string): SorokitResult<void> {
    const migration = this.registry.migrations.get(migrationId);
    if (!migration) {
      return err(
        SorokitErrorCode.VALIDATION,
        `Migration not found: ${migrationId}`,
      );
    }

    this.registry.status.set(migrationId, {
      migrationId,
      status: "pending",
      timestamp: Date.now(),
    });

    return ok(undefined);
  }

  /**
   * Clear all migrations (for testing)
   */
  clearMigrations(): void {
    this.registry.migrations.clear();
    this.registry.status.clear();
  }

  /**
   * Get migration path from source to target version
   */
  getMigrationPath(
    sourceSchema: string,
    sourceVersion: string,
    targetSchema: string,
    targetVersion: string,
  ): SorokitResult<StorageMigration[]> {
    const migrations = Array.from(this.registry.migrations.values());

    // Find migrations that form a path from source to target
    const path: StorageMigration[] = [];
    let currentSchema = sourceSchema;
    let currentVersion = sourceVersion;

    const visited = new Set<string>();

    while (true) {
      const nextMigration = migrations.find(
        (m) =>
          m.source.schema === currentSchema &&
          m.source.version === currentVersion &&
          !visited.has(m.id),
      );

      if (!nextMigration) {
        break;
      }

      visited.add(nextMigration.id);
      path.push(nextMigration);

      currentSchema = nextMigration.target.schema;
      currentVersion = nextMigration.target.version;

      if (currentSchema === targetSchema && currentVersion === targetVersion) {
        return ok(path);
      }

      // Prevent infinite loops
      if (path.length > migrations.length) {
        break;
      }
    }

    return err(
      SorokitErrorCode.VALIDATION,
      `No migration path found from ${sourceSchema}:${sourceVersion} to ${targetSchema}:${targetVersion}`,
    );
  }

  // ─── Private Helpers ───────────────────────────────────────────────────────

  private validateMigration(migration: StorageMigration): SorokitResult<void> {
    if (!migration.id) {
      return err(
        SorokitErrorCode.VALIDATION,
        "Migration must have an id",
      );
    }

    if (!migration.source || !migration.source.schema || !migration.source.version) {
      return err(
        SorokitErrorCode.VALIDATION,
        "Migration must have a valid source version",
      );
    }

    if (!migration.target || !migration.target.schema || !migration.target.version) {
      return err(
        SorokitErrorCode.VALIDATION,
        "Migration must have a valid target version",
      );
    }

    if (!migration.transform || typeof migration.transform !== "function") {
      return err(
        SorokitErrorCode.VALIDATION,
        "Migration must have a transform function",
      );
    }

    return ok(undefined);
  }

  private updateStatus(
    migrationId: string,
    status: MigrationStatus["status"],
    error?: string | undefined,
  ): void {
    const existing = this.registry.status.get(migrationId);
    this.registry.status.set(migrationId, {
      migrationId,
      status,
      timestamp: Date.now(),
      ...(error !== undefined ? { error } : {}),
      ...(existing?.status === "completed" ? { previousStatus: existing.status } : {}),
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ─── Factory ───────────────────────────────────────────────────────────────────

const defaultManager = new StorageMigrationManager();

export function createStorageMigrationManager(
  config?: MigrationConfig,
): StorageMigrationManager {
  return new StorageMigrationManager(config);
}

export function getDefaultStorageMigrationManager(): StorageMigrationManager {
  return defaultManager;
}

// ─── Convenience Functions ─────────────────────────────────────────────────────

/**
 * Register a migration using the default manager
 */
export function registerStorageMigration(
  migration: StorageMigration,
): SorokitResult<void> {
  return defaultManager.registerMigration(migration);
}

/**
 * Apply a migration using the default manager
 */
export async function applyStorageMigration(
  migrationId: string,
  data: unknown,
): Promise<SorokitResult<MigrationResult>> {
  return defaultManager.applyMigration(migrationId, data);
}

/**
 * Rollback a migration using the default manager
 */
export async function rollbackStorageMigration(
  migrationId: string,
  data: unknown,
): Promise<SorokitResult<unknown>> {
  return defaultManager.rollbackMigration(migrationId, data);
}

/**
 * Get migration status using the default manager
 */
export function getStorageMigrationStatus(
  migrationId: string,
): SorokitResult<MigrationStatus> {
  return defaultManager.getMigrationStatus(migrationId);
}

/**
 * List all migrations using the default manager
 */
export function listStorageMigrations(): StorageMigration[] {
  return defaultManager.listMigrations();
}
