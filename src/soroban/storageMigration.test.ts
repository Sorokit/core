/**
 * Tests for Soroban contract storage migration framework with rollback (#519)
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  StorageMigrationManager,
  createStorageMigrationManager,
  type StorageMigration,
  type StorageVersion,
  type MigrationConfig,
} from "./storageMigration";
import { err, ok, SorokitErrorCode } from "../shared/response";

describe("storageMigration", () => {
  let manager: StorageMigrationManager;

  beforeEach(() => {
    manager = createStorageMigrationManager({
      enableAutoRollback: true,
      maxRetries: 3,
      persistStatus: true,
    });
  });

  describe("StorageMigrationManager", () => {
    it("should register a migration", () => {
      const migration: StorageMigration = {
        id: "migration-1",
        source: { schema: "v1", version: "1.0.0" },
        target: { schema: "v2", version: "2.0.0" },
        transform: (data) => ok(data),
      };

      const result = manager.registerMigration(migration);
      expect(result.status).toBe("ok");
    });

    it("should reject duplicate migration ID", () => {
      const migration: StorageMigration = {
        id: "migration-1",
        source: { schema: "v1", version: "1.0.0" },
        target: { schema: "v2", version: "2.0.0" },
        transform: (data) => ok(data),
      };

      manager.registerMigration(migration);
      const result = manager.registerMigration(migration);
      expect(result.status).toBe("error");
    });

    it("should validate migration structure", () => {
      const invalidMigration = {
        id: "migration-1",
        source: { schema: "v1", version: "1.0.0" },
        target: { schema: "v2", version: "2.0.0" },
        // Missing transform
      } as StorageMigration;

      const result = manager.registerMigration(invalidMigration);
      expect(result.status).toBe("error");
    });

    it("should get a registered migration", () => {
      const migration: StorageMigration = {
        id: "migration-1",
        source: { schema: "v1", version: "1.0.0" },
        target: { schema: "v2", version: "2.0.0" },
        transform: (data) => ok(data),
      };

      manager.registerMigration(migration);
      const result = manager.getMigration("migration-1");
      expect(result.status).toBe("ok");

      if (result.status === "ok") {
        expect(result.data.id).toBe("migration-1");
      }
    });

    it("should return error for non-existent migration", () => {
      const result = manager.getMigration("non-existent");
      expect(result.status).toBe("error");
    });

    it("should get migration status", () => {
      const migration: StorageMigration = {
        id: "migration-1",
        source: { schema: "v1", version: "1.0.0" },
        target: { schema: "v2", version: "2.0.0" },
        transform: (data) => ({ status: "ok", data, error: null }),
      };

      manager.registerMigration(migration);
      const result = manager.getMigrationStatus("migration-1");
      expect(result.status).toBe("ok");

      if (result.status === "ok") {
        expect(result.data.status).toBe("pending");
      }
    });

    it("should list all migrations", () => {
      const migration1: StorageMigration = {
        id: "migration-1",
        source: { schema: "v1", version: "1.0.0" },
        target: { schema: "v2", version: "2.0.0" },
        transform: (data) => ok(data),
      };

      const migration2: StorageMigration = {
        id: "migration-2",
        source: { schema: "v2", version: "2.0.0" },
        target: { schema: "v3", version: "3.0.0" },
        transform: (data) => ok(data),
      };

      manager.registerMigration(migration1);
      manager.registerMigration(migration2);

      const migrations = manager.listMigrations();
      expect(migrations.length).toBe(2);
    });

    it("should apply migration successfully", async () => {
      const migration: StorageMigration = {
        id: "migration-1",
        source: { schema: "v1", version: "1.0.0" },
        target: { schema: "v2", version: "2.0.0" },
        transform: (data) => ok({ ...(data as Record<string, unknown>), version: "2.0.0" }),
      };

      manager.registerMigration(migration);

      const result = await manager.applyMigration("migration-1", { value: "test" });
      expect(result.status).toBe("ok");

      if (result.status === "ok") {
        expect(result.data.success).toBe(true);
        expect(result.data.migratedData).toEqual({ value: "test", version: "2.0.0" });
      }
    });

    it("should run pre-migration validation", async () => {
      const migration: StorageMigration = {
        id: "migration-1",
        source: { schema: "v1", version: "1.0.0" },
        target: { schema: "v2", version: "2.0.0" },
        transform: (data) => ok(data),
        validatePreMigration: (data) => {
          if (!data || typeof data !== "object") {
            return err(SorokitErrorCode.VALIDATION, "Invalid data");
          }
          return ok(undefined);
        },
      };

      manager.registerMigration(migration);

      const result = await manager.applyMigration("migration-1", { value: "test" });
      expect(result.status).toBe("ok");

      const invalidResult = await manager.applyMigration("migration-1", null);
      expect(invalidResult.status).toBe("error");
    });

    it("should run post-migration validation", async () => {
      const migration: StorageMigration = {
        id: "migration-1",
        source: { schema: "v1", version: "1.0.0" },
        target: { schema: "v2", version: "2.0.0" },
        transform: (data) => ok({ ...(data as Record<string, unknown>), version: "2.0.0" }),
        validatePostMigration: (data) => {
          if (!data || typeof data !== "object" || !("version" in data)) {
            return err(SorokitErrorCode.VALIDATION, "Missing version");
          }
          return ok(undefined);
        },
      };

      manager.registerMigration(migration);

      const result = await manager.applyMigration("migration-1", { value: "test" });
      expect(result.status).toBe("ok");
    });

    it("should rollback on post-migration validation failure", async () => {
      const migration: StorageMigration = {
        id: "migration-1",
        source: { schema: "v1", version: "1.0.0" },
        target: { schema: "v2", version: "2.0.0" },
        transform: (data) => ok({ ...(data as Record<string, unknown>), version: "2.0.0" }),
        validatePostMigration: (data) => {
          return err(SorokitErrorCode.VALIDATION, "Validation failed");
        },
        rollback: (data) => ok({ ...(data as Record<string, unknown>), version: "1.0.0" }),
      };

      manager.registerMigration(migration);

      const result = await manager.applyMigration("migration-1", { value: "test" });
      expect(result.status).toBe("error");
    });

    it("should retry failed transformations", async () => {
      let attemptCount = 0;
      const migration: StorageMigration = {
        id: "migration-1",
        source: { schema: "v1", version: "1.0.0" },
        target: { schema: "v2", version: "2.0.0" },
        transform: (data) => {
          attemptCount++;
          if (attemptCount < 3) {
            return err(SorokitErrorCode.INTERNAL, "Temporary failure");
          };
          return ok({ ...(data as Record<string, unknown>), version: "2.0.0" });
        },
      };

      manager.registerMigration(migration);

      const result = await manager.applyMigration("migration-1", { value: "test" });
      expect(result.status).toBe("ok");
      expect(attemptCount).toBe(3);
    });

    it("should rollback migration", async () => {
      const migration: StorageMigration = {
        id: "migration-1",
        source: { schema: "v1", version: "1.0.0" },
        target: { schema: "v2", version: "2.0.0" },
        transform: (data) => ok({ ...(data as Record<string, unknown>), version: "2.0.0" }),
        rollback: (data) => ok({ ...(data as Record<string, unknown>), version: "1.0.0" }),
      };

      manager.registerMigration(migration);

      const result = await manager.rollbackMigration("migration-1", { value: "test", version: "2.0.0" });
      expect(result.status).toBe("ok");

      if (result.status === "ok") {
        expect(result.data).toEqual({ value: "test", version: "1.0.0" });
      }
    });

    it("should reject rollback if not supported", async () => {
      const migration: StorageMigration = {
        id: "migration-1",
        source: { schema: "v1", version: "1.0.0" },
        target: { schema: "v2", version: "2.0.0" },
        transform: (data) => ({ status: "ok", data, error: null }),
      };

      manager.registerMigration(migration);

      const result = await manager.rollbackMigration("migration-1", { value: "test" });
      expect(result.status).toBe("error");
    });

    it("should check if migration can be applied", () => {
      const migration: StorageMigration = {
        id: "migration-1",
        source: { schema: "v1", version: "1.0.0" },
        target: { schema: "v2", version: "2.0.0" },
        transform: (data) => ({ status: "ok", data, error: null }),
      };

      manager.registerMigration(migration);

      const result = manager.canApplyMigration("migration-1");
      expect(result.status).toBe("ok");

      if (result.status === "ok") {
        expect(result.data).toBe(true);
      }
    });

    it("should reset migration status", () => {
      const migration: StorageMigration = {
        id: "migration-1",
        source: { schema: "v1", version: "1.0.0" },
        target: { schema: "v2", version: "2.0.0" },
        transform: (data) => ({ status: "ok", data, error: null }),
      };

      manager.registerMigration(migration);

      const result = manager.resetMigrationStatus("migration-1");
      expect(result.status).toBe("ok");

      const statusResult = manager.getMigrationStatus("migration-1");
      expect(statusResult.status === "ok");

      if (statusResult.status === "ok") {
        expect(statusResult.data.status).toBe("pending");
      }
    });

    it("should clear all migrations", () => {
      const migration: StorageMigration = {
        id: "migration-1",
        source: { schema: "v1", version: "1.0.0" },
        target: { schema: "v2", version: "2.0.0" },
        transform: (data) => ({ status: "ok", data, error: null }),
      };

      manager.registerMigration(migration);
      manager.clearMigrations();

      const migrations = manager.listMigrations();
      expect(migrations.length).toBe(0);
    });

    it("should find migration path", () => {
      const migration1: StorageMigration = {
        id: "migration-1",
        source: { schema: "v1", version: "1.0.0" },
        target: { schema: "v2", version: "2.0.0" },
        transform: (data) => ok(data),
      };

      const migration2: StorageMigration = {
        id: "migration-2",
        source: { schema: "v2", version: "2.0.0" },
        target: { schema: "v3", version: "3.0.0" },
        transform: (data) => ok(data),
      };

      manager.registerMigration(migration1);
      manager.registerMigration(migration2);

      const result = manager.getMigrationPath("v1", "1.0.0", "v3", "3.0.0");
      expect(result.status).toBe("ok");

      if (result.status === "ok") {
        expect(result.data.length).toBe(2);
        expect(result.data[0].id).toBe("migration-1");
        expect(result.data[1].id).toBe("migration-2");
      }
    });

    it("should return error if no migration path exists", () => {
      const migration: StorageMigration = {
        id: "migration-1",
        source: { schema: "v1", version: "1.0.0" },
        target: { schema: "v2", version: "2.0.0" },
        transform: (data) => ok(data),
      };

      manager.registerMigration(migration);

      const result = manager.getMigrationPath("v1", "1.0.0", "v3", "3.0.0");
      expect(result.status).toBe("error");
    });

    it("should prevent re-applying completed migration", async () => {
      const migration: StorageMigration = {
        id: "migration-1",
        source: { schema: "v1", version: "1.0.0" },
        target: { schema: "v2", version: "2.0.0" },
        transform: (data) => ok(data),
      };

      manager.registerMigration(migration);

      await manager.applyMigration("migration-1", { value: "test" });
      const result = await manager.applyMigration("migration-1", { value: "test" });
      expect(result.status).toBe("error");
    });
  });
});
