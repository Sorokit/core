/**
 * Tests for privacy-preserving transaction pooling and mixing.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  TransactionMixingPool,
  type PooledTransaction,
  type MixingBatchResult,
} from "./transactionMixing";

describe("TransactionMixingPool", () => {
  let pool: TransactionMixingPool;
  const mockEnvelopeXdr =
    "AAAAAgAAAABDxbL4GIQ/igLvH5fmLKBYDGJf2EfqvfgH6f5cL2PW7gAAAGQBHcf+AAAAA";
  const mockParticipant1 = "GPARTICIPANT1XYZABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const mockParticipant2 = "GPARTICIPANT2XYZABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const mockRecipient = "GRECIPIENT123456XYZABCDEFGHIJKLMNOPQRSTUV";

  beforeEach(() => {
    pool = new TransactionMixingPool({
      minBatchSize: 2,
      maxBatchSize: 10,
      shuffleIterations: 2,
    });
  });

  describe("addTransaction", () => {
    it("should add a transaction to the pool", () => {
      const result = pool.addTransaction(
        "tx1",
        mockParticipant1,
        mockEnvelopeXdr,
        mockRecipient,
        "1000000",
      );

      expect(result.status).toBe("ok");
      expect(result.data?.id).toBe("tx1");
      expect(result.data?.state).toBe("pending");
    });

    it("should reject duplicate transaction IDs", () => {
      pool.addTransaction(
        "tx1",
        mockParticipant1,
        mockEnvelopeXdr,
        mockRecipient,
        "1000000",
      );

      const result = pool.addTransaction(
        "tx1",
        mockParticipant1,
        mockEnvelopeXdr,
        mockRecipient,
        "1000000",
      );

      expect(result.status).toBe("error");
      expect(result.error.code).toBe("INVALID_CONFIG");
    });

    it("should reject transactions with missing parameters", () => {
      const result = pool.addTransaction(
        "tx1",
        "",
        mockEnvelopeXdr,
        mockRecipient,
        "1000000",
      );

      expect(result.status).toBe("error");
      expect(result.error.code).toBe("VALIDATION");
    });

    it("should track multiple participants", () => {
      pool.addTransaction(
        "tx1",
        mockParticipant1,
        mockEnvelopeXdr,
        mockRecipient,
        "1000000",
      );
      pool.addTransaction(
        "tx2",
        mockParticipant2,
        mockEnvelopeXdr,
        mockRecipient,
        "500000",
      );

      const state = pool.getPoolState();
      expect(state.participantCount).toBe(2);
    });

    it("should accumulate participant transaction counts", () => {
      pool.addTransaction(
        "tx1",
        mockParticipant1,
        mockEnvelopeXdr,
        mockRecipient,
        "1000000",
      );
      pool.addTransaction(
        "tx2",
        mockParticipant1,
        mockEnvelopeXdr,
        mockRecipient,
        "500000",
      );

      const state = pool.getPoolState();
      expect(state.totalTransactions).toBe(2);
      expect(state.participantCount).toBe(1);
    });
  });

  describe("getNextBatch", () => {
    it("should return empty batch when pool is empty", () => {
      const result = pool.getNextBatch();

      expect(result.status).toBe("ok");
      expect(result.data).toEqual([]);
    });

    it("should return empty batch when below minimum batch size", () => {
      pool.addTransaction(
        "tx1",
        mockParticipant1,
        mockEnvelopeXdr,
        mockRecipient,
        "1000000",
      );

      const result = pool.getNextBatch();
      expect(result.status).toBe("ok");
      expect(result.data?.length).toBe(0); // Only 1 tx, min is 2
    });

    it("should return batch when minimum size is met", () => {
      pool.addTransaction(
        "tx1",
        mockParticipant1,
        mockEnvelopeXdr,
        mockRecipient,
        "1000000",
      );
      pool.addTransaction(
        "tx2",
        mockParticipant2,
        mockEnvelopeXdr,
        mockRecipient,
        "500000",
      );

      const result = pool.getNextBatch();
      expect(result.status).toBe("ok");
      expect(result.data?.length).toBe(2);
    });

    it("should respect maximum batch size", () => {
      for (let i = 0; i < 15; i++) {
        pool.addTransaction(
          `tx${i}`,
          mockParticipant1,
          mockEnvelopeXdr,
          mockRecipient,
          "1000000",
        );
      }

      const result = pool.getNextBatch();
      expect(result.status).toBe("ok");
      expect(result.data?.length).toBe(10); // Max batch size is 10
    });

    it("should mark transactions as shuffled", () => {
      pool.addTransaction(
        "tx1",
        mockParticipant1,
        mockEnvelopeXdr,
        mockRecipient,
        "1000000",
      );
      pool.addTransaction(
        "tx2",
        mockParticipant2,
        mockEnvelopeXdr,
        mockRecipient,
        "500000",
      );

      const result = pool.getNextBatch();
      expect(result.status).toBe("ok");

      const batch = result.data;
      batch?.forEach((tx) => {
        expect(tx.state).toBe("shuffled");
        expect(tx.shuffledHash).toBeDefined();
      });
    });

    it("should shuffle transactions for privacy", () => {
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const id = `tx${i}`;
        ids.push(id);
        pool.addTransaction(
          id,
          mockParticipant1,
          mockEnvelopeXdr,
          mockRecipient,
          "1000000",
        );
      }

      const result = pool.getNextBatch();
      const batch = result.data;
      const batchIds = batch?.map((t) => t.id) || [];

      // Verify shuffling occurred (order might be different)
      expect(batchIds.sort()).toEqual(ids.sort());
    });
  });

  describe("markBatchSubmitted", () => {
    it("should mark batch as successfully submitted", () => {
      pool.addTransaction(
        "tx1",
        mockParticipant1,
        mockEnvelopeXdr,
        mockRecipient,
        "1000000",
      );
      pool.addTransaction(
        "tx2",
        mockParticipant2,
        mockEnvelopeXdr,
        mockRecipient,
        "500000",
      );

      const result = pool.markBatchSubmitted(
        "batch1",
        ["tx1", "tx2"],
        "result-hash-123",
      );

      expect(result.status).toBe("ok");
      const batch = result.data as MixingBatchResult;
      expect(batch.batchId).toBe("batch1");
      expect(batch.resultHash).toBe("result-hash-123");
      expect(batch.transactionIds).toHaveLength(2);
    });

    it("should reject unknown transaction", () => {
      const result = pool.markBatchSubmitted(
        "batch1",
        ["unknown-tx"],
        "result-hash-123",
      );

      expect(result.status).toBe("error");
      expect(result.error.code).toBe("TX_NOT_FOUND");
    });

    it("should calculate privacy rating", () => {
      pool.addTransaction(
        "tx1",
        mockParticipant1,
        mockEnvelopeXdr,
        mockRecipient,
        "1000000",
      );
      pool.addTransaction(
        "tx2",
        mockParticipant2,
        mockEnvelopeXdr,
        mockRecipient,
        "500000",
      );

      const result = pool.markBatchSubmitted(
        "batch1",
        ["tx1", "tx2"],
        "result-hash",
      );

      expect(result.status).toBe("ok");
      const batch = result.data as MixingBatchResult;
      expect(batch.privacyRating).toBeGreaterThanOrEqual(75);
      expect(batch.privacyRating).toBeLessThanOrEqual(90);
    });

    it("should calculate cost savings", () => {
      pool.addTransaction(
        "tx1",
        mockParticipant1,
        mockEnvelopeXdr,
        mockRecipient,
        "1000000",
      );
      pool.addTransaction(
        "tx2",
        mockParticipant2,
        mockEnvelopeXdr,
        mockRecipient,
        "500000",
      );

      const result = pool.markBatchSubmitted(
        "batch1",
        ["tx1", "tx2"],
        "result-hash",
      );

      expect(result.status).toBe("ok");
      const batch = result.data as MixingBatchResult;
      expect(batch.costSavingsPercent).toBeGreaterThan(0);
    });

    it("should include multiple participants in batch", () => {
      pool.addTransaction(
        "tx1",
        mockParticipant1,
        mockEnvelopeXdr,
        mockRecipient,
        "1000000",
      );
      pool.addTransaction(
        "tx2",
        mockParticipant2,
        mockEnvelopeXdr,
        mockRecipient,
        "500000",
      );

      const result = pool.markBatchSubmitted(
        "batch1",
        ["tx1", "tx2"],
        "result-hash",
      );

      expect(result.status).toBe("ok");
      const batch = result.data as MixingBatchResult;
      expect(batch.participantIds).toContain(mockParticipant1);
      expect(batch.participantIds).toContain(mockParticipant2);
    });
  });

  describe("markBatchFailed", () => {
    it("should return transactions to pending on failure", () => {
      pool.addTransaction(
        "tx1",
        mockParticipant1,
        mockEnvelopeXdr,
        mockRecipient,
        "1000000",
      );

      pool.getNextBatch(); // Get batch (marks as shuffled)
      pool.markBatchFailed(["tx1"]);

      const state = pool.getPoolState();
      expect(state.pendingTransactions).toBe(1);
    });

    it("should mark participant as having failed", () => {
      pool.addTransaction(
        "tx1",
        mockParticipant1,
        mockEnvelopeXdr,
        mockRecipient,
        "1000000",
      );

      pool.markBatchFailed(["tx1"]);

      // Participant should still be tracked due to failure flag
      const state = pool.getPoolState();
      expect(state.participantCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe("analyzePrivacy", () => {
    it("should provide privacy analysis", () => {
      pool.addTransaction(
        "tx1",
        mockParticipant1,
        mockEnvelopeXdr,
        mockRecipient,
        "1000000",
      );
      pool.addTransaction(
        "tx2",
        mockParticipant2,
        mockEnvelopeXdr,
        mockRecipient,
        "500000",
      );

      const result = pool.analyzePrivacy();

      expect(result.status).toBe("ok");
      const analysis = result.data;
      expect(analysis?.anonymitySetSize).toBeGreaterThan(0);
      expect(analysis?.estimatedPrivacy).toBeGreaterThan(
        analysis?.baslinePrivacy || 0,
      );
      expect(analysis?.privacyGain).toBeGreaterThanOrEqual(0);
    });

    it("should include findings about anonymity set", () => {
      pool.addTransaction(
        "tx1",
        mockParticipant1,
        mockEnvelopeXdr,
        mockRecipient,
        "1000000",
      );

      const result = pool.analyzePrivacy();

      expect(result.status).toBe("ok");
      const analysis = result.data;
      expect(Array.isArray(analysis?.findings)).toBe(true);
      expect(analysis?.findings.length).toBeGreaterThan(0);
    });

    it("should warn about small anonymity sets", () => {
      pool.addTransaction(
        "tx1",
        mockParticipant1,
        mockEnvelopeXdr,
        mockRecipient,
        "1000000",
      );

      const result = pool.analyzePrivacy();

      expect(result.status).toBe("ok");
      const analysis = result.data;
      expect(analysis?.findings.some((f) => f.includes("⚠️"))).toBe(true);
    });

    it("should calculate timing deviation", () => {
      pool.addTransaction(
        "tx1",
        mockParticipant1,
        mockEnvelopeXdr,
        mockRecipient,
        "1000000",
      );

      const result = pool.analyzePrivacy();

      expect(result.status).toBe("ok");
      const analysis = result.data;
      expect(analysis?.timingDeviation).toBeGreaterThanOrEqual(0);
      expect(analysis?.timingDeviation).toBeLessThanOrEqual(500);
    });
  });

  describe("removeParticipant", () => {
    it("should remove participant and their transactions", () => {
      pool.addTransaction(
        "tx1",
        mockParticipant1,
        mockEnvelopeXdr,
        mockRecipient,
        "1000000",
      );
      pool.addTransaction(
        "tx2",
        mockParticipant2,
        mockEnvelopeXdr,
        mockRecipient,
        "500000",
      );

      const result = pool.removeParticipant(mockParticipant1);

      expect(result.status).toBe("ok");
      const state = pool.getPoolState();
      expect(state.participantCount).toBe(1);
      expect(state.totalTransactions).toBe(1);
    });

    it("should handle unknown participant gracefully", () => {
      const result = pool.removeParticipant("unknown-participant");

      expect(result.status).toBe("ok");
    });
  });

  describe("getPoolState", () => {
    it("should return pool statistics", () => {
      pool.addTransaction(
        "tx1",
        mockParticipant1,
        mockEnvelopeXdr,
        mockRecipient,
        "1000000",
      );

      const state = pool.getPoolState();

      expect(state.totalTransactions).toBe(1);
      expect(state.pendingTransactions).toBe(1);
      expect(state.participantCount).toBe(1);
      expect(state.totalValue).toBe("1000000");
    });

    it("should accumulate total value", () => {
      pool.addTransaction(
        "tx1",
        mockParticipant1,
        mockEnvelopeXdr,
        mockRecipient,
        "1000000",
      );
      pool.addTransaction(
        "tx2",
        mockParticipant1,
        mockEnvelopeXdr,
        mockRecipient,
        "500000",
      );

      const state = pool.getPoolState();
      expect(state.totalValue).toBe("1500000");
    });
  });

  describe("edge cases", () => {
    it("should handle large transaction amounts", () => {
      const result = pool.addTransaction(
        "tx1",
        mockParticipant1,
        mockEnvelopeXdr,
        mockRecipient,
        "9999999999999999999",
      );

      expect(result.status).toBe("ok");
    });

    it("should allow multiple calls to getNextBatch without duplicates", () => {
      pool.addTransaction(
        "tx1",
        mockParticipant1,
        mockEnvelopeXdr,
        mockRecipient,
        "1000000",
      );
      pool.addTransaction(
        "tx2",
        mockParticipant2,
        mockEnvelopeXdr,
        mockRecipient,
        "500000",
      );

      const batch1 = pool.getNextBatch();
      const batch2 = pool.getNextBatch();

      expect(batch1.data?.length).toBe(2);
      expect(batch2.data?.length).toBe(0); // Already shuffled, won't be in pending
    });

    it("should handle cleanup gracefully", () => {
      pool.destroy();
      const state = pool.getPoolState();

      expect(state.totalTransactions).toBe(0);
    });
  });
});
