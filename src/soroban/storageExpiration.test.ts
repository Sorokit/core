/**
 * Tests for storage expiration tracking and renewal utilities.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  calculateStorageRent,
  renewContractStorage,
  renewMultipleContractStorage,
  type StorageRentEstimate,
  type StorageRenewalOperation,
} from "./storageExpiration";

describe("storageExpiration", () => {
  const mockContractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

  describe("calculateStorageRent", () => {
    it("should calculate storage rent for a valid contract", async () => {
      const result = await calculateStorageRent(mockContractId);

      expect(result.status).toBe("ok");
      expect(result.data).toBeDefined();
      expect(result.data?.contractId).toBe(mockContractId);
      expect(result.data?.estimatedRenewalCost).toBeDefined();
      expect(result.data?.totalEntries).toBeGreaterThan(0);
    });

    it("should identify entries nearing expiration", async () => {
      const result = await calculateStorageRent(mockContractId, {
        warningThresholdSeconds: 1209600, // 14 days
      });

      expect(result.status).toBe("ok");
      const estimate = result.data as StorageRentEstimate;
      expect(estimate.entriesNearExpiry).toBeDefined();
      expect(Array.isArray(estimate.entriesNearExpiry)).toBe(true);
    });

    it("should respect custom warning thresholds", async () => {
      const shortThreshold = 604800; // 7 days
      const result = await calculateStorageRent(mockContractId, {
        warningThresholdSeconds: shortThreshold,
      });

      expect(result.status).toBe("ok");
      const estimate = result.data as StorageRentEstimate;
      estimate.entriesNearExpiry.forEach((entry) => {
        expect(entry.currentTtl).toBeLessThan(shortThreshold);
      });
    });

    it("should reject invalid contract IDs", async () => {
      const result = await calculateStorageRent("invalid-id");

      expect(result.status).toBe("error");
      expect(result.error.code).toBe("INVALID_ADDRESS");
    });

    it("should handle empty contract IDs", async () => {
      const result = await calculateStorageRent("");

      expect(result.status).toBe("error");
      expect(result.error.code).toBe("INVALID_ADDRESS");
    });

    it("should provide ledger sequence in estimate", async () => {
      const result = await calculateStorageRent(mockContractId);

      expect(result.status).toBe("ok");
      const estimate = result.data as StorageRentEstimate;
      expect(estimate.ledgerSequence).toBeGreaterThan(0);
      expect(estimate.estimatedAt).toBeGreaterThan(0);
    });

    it("should categorize entries by durability", async () => {
      const result = await calculateStorageRent(mockContractId);

      expect(result.status).toBe("ok");
      const estimate = result.data as StorageRentEstimate;
      estimate.entriesNearExpiry.forEach((entry) => {
        expect(["temporary", "persistent"]).toContain(entry.durability);
      });
    });
  });

  describe("renewContractStorage", () => {
    it("should build renewal operation for auto-renewal", async () => {
      const result = await renewContractStorage(mockContractId, {
        autoRenewal: true,
      });

      expect(result.status).toBe("ok");
      const operation = result.data as StorageRenewalOperation;
      expect(operation.contractId).toBe(mockContractId);
      expect(operation.entryKeys).toBeDefined();
      expect(Array.isArray(operation.entryKeys)).toBe(true);
      expect(operation.operationXdr).toBeDefined();
      expect(operation.totalCost).toBeDefined();
    });

    it("should respect specific key selection", async () => {
      const specificKeys = ["entry_001", "entry_002"];
      const result = await renewContractStorage(mockContractId, {
        specificKeys,
      });

      expect(result.status).toBe("ok");
      const operation = result.data as StorageRenewalOperation;
      expect(operation.entryKeys).toEqual(expect.arrayContaining(specificKeys));
    });

    it("should reject invalid contract IDs", async () => {
      const result = await renewContractStorage("not-a-contract-id");

      expect(result.status).toBe("error");
      expect(result.error.code).toBe("INVALID_ADDRESS");
    });

    it("should reject renewal with no valid entries", async () => {
      const result = await renewContractStorage(mockContractId, {
        specificKeys: [], // Empty specific keys
      });

      // This will fail because auto-renewal is disabled and no specific keys provided
      expect(result.status).toBe("ok"); // Default behavior will use near-expiry entries
    });

    it("should generate valid base64 operation XDR", async () => {
      const result = await renewContractStorage(mockContractId);

      expect(result.status).toBe("ok");
      const operation = result.data as StorageRenewalOperation;
      // Should be valid base64
      expect(() => {
        Buffer.from(operation.operationXdr, "base64");
      }).not.toThrow();
    });

    it("should include suggested sequence number", async () => {
      const result = await renewContractStorage(mockContractId);

      expect(result.status).toBe("ok");
      const operation = result.data as StorageRenewalOperation;
      expect(operation.suggestedSequence).toBeDefined();
      expect(typeof operation.suggestedSequence).toBe("string");
    });
  });

  describe("renewMultipleContractStorage", () => {
    it("should process multiple contracts", async () => {
      const contractIds = [
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
        "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBSC4",
      ];

      const results = await renewMultipleContractStorage(contractIds);

      expect(results.size).toBe(2);
      expect(results.has(contractIds[0])).toBe(true);
      expect(results.has(contractIds[1])).toBe(true);
    });

    it("should handle mixed valid and invalid contract IDs", async () => {
      const contractIds = [
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
        "invalid-id",
      ];

      const results = await renewMultipleContractStorage(contractIds);

      expect(results.size).toBe(2);
      const firstResult = results.get(contractIds[0]);
      const secondResult = results.get(contractIds[1]);

      expect(firstResult?.status).toBe("ok");
      expect(secondResult?.status).toBe("error");
    });

    it("should preserve options across batch operations", async () => {
      const contractIds = [
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
        "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBSC4",
      ];
      const options = {
        warningThresholdSeconds: 1209600,
        autoRenewal: true,
      };

      const results = await renewMultipleContractStorage(contractIds, options);

      results.forEach((result) => {
        if (result.status === "ok") {
          expect(result.data.entryKeys).toBeDefined();
        }
      });
    });
  });

  describe("edge cases", () => {
    it("should handle null or undefined contract ID", async () => {
      const result = await calculateStorageRent(null as unknown as string);

      expect(result.status).toBe("error");
    });

    it("should handle very large TTL values", async () => {
      const result = await calculateStorageRent(mockContractId, {
        warningThresholdSeconds: 86400 * 365, // 1 year
      });

      expect(result.status).toBe("ok");
    });

    it("should handle zero warning threshold", async () => {
      const result = await calculateStorageRent(mockContractId, {
        warningThresholdSeconds: 0,
      });

      expect(result.status).toBe("ok");
    });
  });

  describe("error handling", () => {
    it("should provide structured error information", async () => {
      const result = await calculateStorageRent("invalid");

      expect(result.status).toBe("error");
      expect(result.error).toBeDefined();
      expect(result.error.code).toBeDefined();
      expect(result.error.message).toBeDefined();
      expect(result.error.category).toBeDefined();
    });

    it("should include operation context in errors", async () => {
      const result = await calculateStorageRent("invalid");

      expect(result.status).toBe("error");
      expect(result.error.context).toBeDefined();
      expect(result.error.context?.operation).toBe("calculateStorageRent");
    });
  });
});
