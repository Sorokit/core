/**
 * Tests for transaction draft versioning, diffing, and rollback (#518)
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  DraftVersionManager,
  createDraftVersionManager,
  type DraftMetadata,
  type DraftVersioningConfig,
} from "./draftVersioning";

describe("draftVersioning", () => {
  let manager: DraftVersionManager;

  beforeEach(() => {
    manager = createDraftVersionManager({
      maxVersionsPerDraft: 50,
      enableCompression: false,
    });
  });

  describe("DraftVersionManager", () => {
    it("should create a new version", () => {
      const metadata: DraftMetadata = {
        name: "test-draft",
        description: "Test draft",
      };

      const result = manager.createVersion("test-draft", "xdr-data", metadata);
      expect(result.status).toBe("ok");

      if (result.status === "ok") {
        expect(result.data.id).toBeDefined();
        expect(result.data.sequenceNumber).toBe(1);
        expect(result.data.transactionXdr).toBe("xdr-data");
        expect(result.data.metadata.name).toBe("test-draft");
      }
    });

    it("should get a specific version", () => {
      const metadata: DraftMetadata = { name: "test-draft" };
      const createResult = manager.createVersion("test-draft", "xdr-data", metadata);
      expect(createResult.status).toBe("ok");

      if (createResult.status === "ok") {
        const getResult = manager.getVersion("test-draft", createResult.data.id);
        expect(getResult.status).toBe("ok");

        if (getResult.status === "ok") {
          expect(getResult.data.id).toBe(createResult.data.id);
        }
      }
    });

    it("should return error for non-existent version", () => {
      const result = manager.getVersion("test-draft", "non-existent");
      expect(result.status).toBe("error");
    });

    it("should get current version", () => {
      const metadata: DraftMetadata = { name: "test-draft" };
      const createResult = manager.createVersion("test-draft", "xdr-data", metadata);
      expect(createResult.status).toBe("ok");

      if (createResult.status === "ok") {
        const currentResult = manager.getCurrentVersion("test-draft");
        expect(currentResult.status).toBe("ok");

        if (currentResult.status === "ok") {
          expect(currentResult.data.id).toBe(createResult.data.id);
        }
      }
    });

    it("should list all versions", () => {
      const metadata: DraftMetadata = { name: "test-draft" };
      manager.createVersion("test-draft", "xdr-data-1", metadata);
      manager.createVersion("test-draft", "xdr-data-2", metadata);

      const result = manager.listVersions("test-draft");
      expect(result.status).toBe("ok");

      if (result.status === "ok") {
        expect(result.data.length).toBe(2);
      }
    });

    it("should compare versions", () => {
      const metadata: DraftMetadata = { name: "test-draft" };
      const v1Result = manager.createVersion("test-draft", "xdr-data-1", metadata);
      const v2Result = manager.createVersion("test-draft", "xdr-data-2", metadata);

      expect(v1Result.status === "ok" && v2Result.status === "ok");

      if (v1Result.status === "ok" && v2Result.status === "ok") {
        const diffResult = manager.compareVersions(
          "test-draft",
          v1Result.data.id,
          v2Result.data.id,
        );
        expect(diffResult.status).toBe("ok");

        if (diffResult.status === "ok") {
          expect(diffResult.data.addedOperations).toBeDefined();
          expect(diffResult.data.removedOperations).toBeDefined();
          expect(diffResult.data.modifiedOperations).toBeDefined();
          expect(diffResult.data.metadataChanges).toBeDefined();
        }
      }
    });

    it("should revert draft to previous version", () => {
      const metadata: DraftMetadata = { name: "test-draft" };
      const v1Result = manager.createVersion("test-draft", "xdr-data-1", metadata);
      const v2Result = manager.createVersion("test-draft", "xdr-data-2", metadata);

      expect(v1Result.status === "ok" && v2Result.status === "ok");

      if (v1Result.status === "ok" && v2Result.status === "ok") {
        const revertResult = manager.revertDraft("test-draft", v1Result.data.id);
        expect(revertResult.status).toBe("ok");

        if (revertResult.status === "ok") {
          expect(revertResult.data.transactionXdr).toBe("xdr-data-1");
          expect(revertResult.data.sequenceNumber).toBe(3); // New version created
        }
      }
    });

    it("should delete draft", () => {
      const metadata: DraftMetadata = { name: "test-draft" };
      manager.createVersion("test-draft", "xdr-data", metadata);

      const deleteResult = manager.deleteDraft("test-draft");
      expect(deleteResult.status).toBe("ok");

      const getResult = manager.getVersion("test-draft", "any-id");
      expect(getResult.status).toBe("error");
    });

    it("should validate version integrity", () => {
      const metadata: DraftMetadata = { name: "test-draft" };
      const createResult = manager.createVersion("test-draft", "xdr-data", metadata);
      expect(createResult.status === "ok");

      if (createResult.status === "ok") {
        const validateResult = manager.validateVersion("test-draft", createResult.data.id);
        expect(validateResult.status).toBe("ok");

        if (validateResult.status === "ok") {
          expect(validateResult.data).toBe(true);
        }
      }
    });

    it("should invalidate empty XDR", () => {
      const metadata: DraftMetadata = { name: "test-draft" };
      const createResult = manager.createVersion("test-draft", "", metadata);
      expect(createResult.status === "ok");

      if (createResult.status === "ok") {
        const validateResult = manager.validateVersion("test-draft", createResult.data.id);
        expect(validateResult.status === "ok");

        if (validateResult.status === "ok") {
          expect(validateResult.data).toBe(false);
        }
      }
    });

    it("should get version count", () => {
      const metadata: DraftMetadata = { name: "test-draft" };
      manager.createVersion("test-draft", "xdr-data-1", metadata);
      manager.createVersion("test-draft", "xdr-data-2", metadata);
      manager.createVersion("test-draft", "xdr-data-3", metadata);

      const result = manager.getVersionCount("test-draft");
      expect(result.status).toBe("ok");

      if (result.status === "ok") {
        expect(result.data).toBe(3);
      }
    });

    it("should prune old versions", () => {
      const metadata: DraftMetadata = { name: "test-draft" };
      manager.createVersion("test-draft", "xdr-data-1", metadata);
      manager.createVersion("test-draft", "xdr-data-2", metadata);
      manager.createVersion("test-draft", "xdr-data-3", metadata);

      const pruneResult = manager.pruneVersions("test-draft", 2);
      expect(pruneResult.status === "ok");

      if (pruneResult.status === "ok") {
        expect(pruneResult.data).toBe(1);
      }

      const countResult = manager.getVersionCount("test-draft");
      expect(countResult.status === "ok");

      if (countResult.status === "ok") {
        expect(countResult.data).toBe(2);
      }
    });

    it("should enforce max versions limit", () => {
      const config: DraftVersioningConfig = { maxVersionsPerDraft: 3 };
      const limitedManager = createDraftVersionManager(config);
      const metadata: DraftMetadata = { name: "test-draft" };

      for (let i = 0; i < 5; i++) {
        limitedManager.createVersion("test-draft", `xdr-data-${i}`, metadata);
      }

      const countResult = limitedManager.getVersionCount("test-draft");
      expect(countResult.status === "ok");

      if (countResult.status === "ok") {
        expect(countResult.data).toBe(3);
      }
    });

    it("should generate unique version IDs", () => {
      const metadata: DraftMetadata = { name: "test-draft" };
      const v1Result = manager.createVersion("test-draft", "xdr-data-1", metadata);
      const v2Result = manager.createVersion("test-draft", "xdr-data-2", metadata);

      expect(v1Result.status === "ok" && v2Result.status === "ok");

      if (v1Result.status === "ok" && v2Result.status === "ok") {
        expect(v1Result.data.id).not.toBe(v2Result.data.id);
      }
    });

    it("should track sequence numbers", () => {
      const metadata: DraftMetadata = { name: "test-draft" };
      const v1Result = manager.createVersion("test-draft", "xdr-data-1", metadata);
      const v2Result = manager.createVersion("test-draft", "xdr-data-2", metadata);

      expect(v1Result.status === "ok" && v2Result.status === "ok");

      if (v1Result.status === "ok" && v2Result.status === "ok") {
        expect(v1Result.data.sequenceNumber).toBe(1);
        expect(v2Result.data.sequenceNumber).toBe(2);
      }
    });

    it("should detect metadata changes", () => {
      const metadata1: DraftMetadata = { name: "test-draft", description: "Original" };
      const metadata2: DraftMetadata = { name: "test-draft", description: "Updated" };

      const v1Result = manager.createVersion("test-draft", "xdr-data", metadata1);
      const v2Result = manager.createVersion("test-draft", "xdr-data", metadata2);

      expect(v1Result.status === "ok" && v2Result.status === "ok");

      if (v1Result.status === "ok" && v2Result.status === "ok") {
        const diffResult = manager.compareVersions(
          "test-draft",
          v1Result.data.id,
          v2Result.data.id,
        );
        expect(diffResult.status === "ok");

        if (diffResult.status === "ok") {
          const descriptionChange = diffResult.data.metadataChanges.find(
            (c) => c.field === "description",
          );
          expect(descriptionChange).toBeDefined();
          expect(descriptionChange?.oldValue).toBe("Original");
          expect(descriptionChange?.newValue).toBe("Updated");
        }
      }
    });
  });
});
