/**
 * Tests for transaction queue with priority scheduling.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  TransactionQueue,
  type QueuedTransaction,
  type QueueState,
} from "./transactionQueue";

describe("TransactionQueue", () => {
  let queue: TransactionQueue;
  const mockEnvelopeXdr =
    "AAAAAgAAAABDxbL4GIQ/igLvH5fmLKBYDGJf2EfqvfgH6f5cL2PW7gAAAGQBHcf+AAAAA";

  beforeEach(() => {
    queue = new TransactionQueue({
      batchSize: 5,
      schedulingIntervalMs: 1000,
    });
  });

  describe("enqueue", () => {
    it("should enqueue a transaction with default priority", () => {
      const result = queue.enqueue("tx1", mockEnvelopeXdr);

      expect(result.status).toBe("ok");
      expect(result.data?.id).toBe("tx1");
      expect(result.data?.priority).toBe("normal");
      expect(result.data?.status).toBe("pending");
    });

    it("should enqueue a transaction with specified priority", () => {
      const result = queue.enqueue("tx1", mockEnvelopeXdr, "high");

      expect(result.status).toBe("ok");
      expect(result.data?.priority).toBe("high");
    });

    it("should reject duplicate transaction IDs", () => {
      queue.enqueue("tx1", mockEnvelopeXdr);
      const result = queue.enqueue("tx1", mockEnvelopeXdr);

      expect(result.status).toBe("error");
      expect(result.error.code).toBe("INVALID_CONFIG");
    });

    it("should validate dependency references", () => {
      const result = queue.enqueue("tx1", mockEnvelopeXdr, "normal", [
        "nonexistent",
      ]);

      expect(result.status).toBe("error");
      expect(result.error.code).toBe("INVALID_CONFIG");
    });

    it("should accept valid dependencies", () => {
      queue.enqueue("tx1", mockEnvelopeXdr);
      const result = queue.enqueue("tx2", mockEnvelopeXdr, "normal", ["tx1"]);

      expect(result.status).toBe("ok");
      expect(result.data?.dependsOn).toContain("tx1");
    });

    it("should respect maximum queue size", () => {
      const smallQueue = new TransactionQueue({ maxQueueSize: 2 });

      expect(smallQueue.enqueue("tx1", mockEnvelopeXdr).status).toBe("ok");
      expect(smallQueue.enqueue("tx2", mockEnvelopeXdr).status).toBe("ok");
      expect(smallQueue.enqueue("tx3", mockEnvelopeXdr).status).toBe("error");
    });
  });

  describe("getState", () => {
    it("should return initial empty state", () => {
      const state = queue.getState();

      expect(state.pending).toBe(0);
      expect(state.processing).toBe(0);
      expect(state.completed).toBe(0);
      expect(state.failed).toBe(0);
    });

    it("should track pending transactions", () => {
      queue.enqueue("tx1", mockEnvelopeXdr);
      queue.enqueue("tx2", mockEnvelopeXdr);

      const state = queue.getState();
      expect(state.pending).toBe(2);
    });

    it("should track completed transactions", () => {
      queue.enqueue("tx1", mockEnvelopeXdr);
      queue.markCompleted("tx1", "hash1");

      const state = queue.getState();
      expect(state.completed).toBe(1);
      expect(state.pending).toBe(0);
    });

    it("should track failed transactions", () => {
      queue.enqueue("tx1", mockEnvelopeXdr, "normal", undefined);
      queue.markFailed("tx1", "Error message");
      queue.markFailed("tx1", "Error message");
      queue.markFailed("tx1", "Error message");
      queue.markFailed("tx1", "Error message");

      const state = queue.getState();
      expect(state.failed).toBe(1);
    });
  });

  describe("getNextBatch", () => {
    it("should return empty batch when queue is empty", () => {
      const batch = queue.getNextBatch();

      expect(batch).toEqual([]);
    });

    it("should return pending transactions", () => {
      queue.enqueue("tx1", mockEnvelopeXdr);
      queue.enqueue("tx2", mockEnvelopeXdr);

      const batch = queue.getNextBatch();
      expect(batch.length).toBe(2);
    });

    it("should respect batch size limit", () => {
      for (let i = 0; i < 10; i++) {
        queue.enqueue(`tx${i}`, mockEnvelopeXdr);
      }

      const batch = queue.getNextBatch();
      expect(batch.length).toBe(5); // Default batchSize is 5
    });

    it("should prioritize transactions by level", () => {
      queue.enqueue("tx1", mockEnvelopeXdr, "low");
      queue.enqueue("tx2", mockEnvelopeXdr, "critical");
      queue.enqueue("tx3", mockEnvelopeXdr, "normal");
      queue.enqueue("tx4", mockEnvelopeXdr, "high");

      const batch = queue.getNextBatch();
      expect(batch[0].id).toBe("tx2"); // critical
      expect(batch[1].id).toBe("tx4"); // high
      expect(batch[2].id).toBe("tx3"); // normal
      expect(batch[3].id).toBe("tx1"); // low
    });

    it("should exclude transactions with unsatisfied dependencies", () => {
      queue.enqueue("tx1", mockEnvelopeXdr);
      queue.enqueue("tx2", mockEnvelopeXdr, "normal", ["tx1"]);
      queue.enqueue("tx3", mockEnvelopeXdr);

      const batch = queue.getNextBatch();
      expect(batch.map((t) => t.id)).toContain("tx1");
      expect(batch.map((t) => t.id)).not.toContain("tx2");
      expect(batch.map((t) => t.id)).toContain("tx3");
    });

    it("should include transactions after dependencies complete", () => {
      queue.enqueue("tx1", mockEnvelopeXdr);
      queue.enqueue("tx2", mockEnvelopeXdr, "normal", ["tx1"]);

      let batch = queue.getNextBatch();
      expect(batch.map((t) => t.id)).toContain("tx1");
      expect(batch.map((t) => t.id)).not.toContain("tx2");

      queue.markCompleted("tx1");
      batch = queue.getNextBatch();
      expect(batch.map((t) => t.id)).toContain("tx2");
    });
  });

  describe("markCompleted", () => {
    it("should mark transaction as completed", () => {
      queue.enqueue("tx1", mockEnvelopeXdr);
      const result = queue.markCompleted("tx1", "hash1");

      expect(result.status).toBe("ok");
      const tx = queue.get("tx1");
      expect(tx?.status).toBe("completed");
      expect(tx?.resultHash).toBe("hash1");
      expect(tx?.completedAt).toBeDefined();
    });

    it("should reject unknown transaction", () => {
      const result = queue.markCompleted("unknown", "hash");

      expect(result.status).toBe("error");
      expect(result.error.code).toBe("TX_NOT_FOUND");
    });
  });

  describe("markFailed", () => {
    it("should mark transaction as failed after max retries", () => {
      queue.enqueue("tx1", mockEnvelopeXdr);

      queue.markFailed("tx1", "Error");
      queue.markFailed("tx1", "Error");
      queue.markFailed("tx1", "Error");
      const result = queue.markFailed("tx1", "Error");

      expect(result.status).toBe("ok");
      expect(result.data).toBe("failed");

      const tx = queue.get("tx1");
      expect(tx?.status).toBe("failed");
      expect(tx?.retryCount).toBe(4);
    });

    it("should return to pending on retry", () => {
      queue.enqueue("tx1", mockEnvelopeXdr);

      const result = queue.markFailed("tx1", "Error");

      expect(result.status).toBe("ok");
      expect(result.data).toBe("retry");

      const tx = queue.get("tx1");
      expect(tx?.status).toBe("pending");
      expect(tx?.retryCount).toBe(1);
    });

    it("should reject unknown transaction", () => {
      const result = queue.markFailed("unknown", "Error");

      expect(result.status).toBe("error");
      expect(result.error.code).toBe("TX_NOT_FOUND");
    });
  });

  describe("cancel", () => {
    it("should cancel a pending transaction", () => {
      queue.enqueue("tx1", mockEnvelopeXdr);
      const result = queue.cancel("tx1");

      expect(result.status).toBe("ok");
      expect(queue.get("tx1")).toBeUndefined();
    });

    it("should reject cancellation of completed transaction", () => {
      queue.enqueue("tx1", mockEnvelopeXdr);
      queue.markCompleted("tx1");

      const result = queue.cancel("tx1");
      expect(result.status).toBe("error");
      expect(result.error.code).toBe("INVALID_CONFIG");
    });

    it("should reject cancellation of processing transaction", () => {
      queue.enqueue("tx1", mockEnvelopeXdr);
      const tx = queue.get("tx1");
      if (tx) tx.status = "processing";

      const result = queue.cancel("tx1");
      expect(result.status).toBe("error");
    });

    it("should reject unknown transaction", () => {
      const result = queue.cancel("unknown");

      expect(result.status).toBe("error");
      expect(result.error.code).toBe("TX_NOT_FOUND");
    });
  });

  describe("clear", () => {
    it("should clear all transactions", () => {
      queue.enqueue("tx1", mockEnvelopeXdr);
      queue.enqueue("tx2", mockEnvelopeXdr);

      queue.clear();

      expect(queue.getState().pending).toBe(0);
    });

    it("should clear only completed transactions", () => {
      queue.enqueue("tx1", mockEnvelopeXdr);
      queue.enqueue("tx2", mockEnvelopeXdr);
      queue.markCompleted("tx1");

      queue.clear("completed");

      expect(queue.get("tx1")).toBeUndefined();
      expect(queue.get("tx2")).toBeDefined();
    });

    it("should clear only failed transactions", () => {
      queue.enqueue("tx1", mockEnvelopeXdr);
      queue.enqueue("tx2", mockEnvelopeXdr);
      queue.markFailed("tx1", "Error");
      queue.markFailed("tx1", "Error");
      queue.markFailed("tx1", "Error");
      queue.markFailed("tx1", "Error");

      queue.clear("failed");

      expect(queue.get("tx1")).toBeUndefined();
      expect(queue.get("tx2")).toBeDefined();
    });
  });

  describe("get", () => {
    it("should retrieve a queued transaction", () => {
      queue.enqueue("tx1", mockEnvelopeXdr);

      const tx = queue.get("tx1");
      expect(tx).toBeDefined();
      expect(tx?.id).toBe("tx1");
    });

    it("should return undefined for unknown transaction", () => {
      const tx = queue.get("unknown");

      expect(tx).toBeUndefined();
    });
  });

  describe("edge cases", () => {
    it("should handle empty dependencies array", () => {
      const result = queue.enqueue("tx1", mockEnvelopeXdr, "normal", []);

      expect(result.status).toBe("ok");
    });

    it("should handle circular dependency chains gracefully", () => {
      queue.enqueue("tx1", mockEnvelopeXdr, "normal", ["tx2"]);
      const result = queue.enqueue("tx2", mockEnvelopeXdr, "normal", ["tx1"]);

      // tx2 depends on tx1, but tx1 depends on tx2 - should still allow enqueue
      expect(result.status).toBe("ok");
    });

    it("should handle many transactions", () => {
      for (let i = 0; i < 100; i++) {
        const result = queue.enqueue(`tx${i}`, mockEnvelopeXdr);
        expect(result.status).toBe("ok");
      }

      expect(queue.getState().pending).toBe(100);
    });
  });
});
