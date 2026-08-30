/**
 * Tests for multi-party transaction consensus workflow.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  createConsensusTransaction,
  approveConsensusTransaction,
  rejectConsensusTransaction,
  getConsensusSummaryResult,
  finalizeConsensusTransaction,
  getConsensusTransaction,
  removeConsensusTransaction,
} from "./consensusCore";
import type { ConsensusParticipant } from "./consensusTypes";
import { ConsensusState } from "./consensusTypes";
import { SorokitErrorCode } from "../shared/response";

const createTestParticipants = (count: number): ConsensusParticipant[] => {
  return Array.from({ length: count }, (_, i) => ({
    participantId: `participant-${i + 1}`,
    name: `Participant ${i + 1}`,
    approved: false,
    rejected: false,
  }));
};

describe("Consensus Transaction", () => {
  let consensusId: string;

  beforeEach(() => {
    const participants = createTestParticipants(3);
    const result = createConsensusTransaction(2, participants);
    if (result.status === "ok") {
      consensusId = result.data!.consensusId;
    }
  });

  describe("createConsensusTransaction", () => {
    it("should create a consensus transaction with valid config", () => {
      const participants = createTestParticipants(3);
      const result = createConsensusTransaction(2, participants);

      expect(result.status).toBe("ok");
      expect(result.data!.threshold).toBe(2);
      expect(result.data!.totalParticipants).toBe(3);
      expect(result.data!.state).toBe(ConsensusState.PROPOSAL);
      expect(result.data!.consensusId).toBeDefined();
    });

    it("should reject invalid threshold (not positive)", () => {
      const participants = createTestParticipants(3);
      const result = createConsensusTransaction(0, participants);

      expect(result.status).toBe("error");
      expect(result.error?.code).toBe(SorokitErrorCode.INVALID_CONFIG);
    });

    it("should reject threshold exceeding participant count", () => {
      const participants = createTestParticipants(3);
      const result = createConsensusTransaction(5, participants);

      expect(result.status).toBe("error");
      expect(result.error?.code).toBe(SorokitErrorCode.INVALID_CONFIG);
    });

    it("should reject empty participants array", () => {
      const result = createConsensusTransaction(1, []);

      expect(result.status).toBe("error");
      expect(result.error?.code).toBe(SorokitErrorCode.INVALID_CONFIG);
    });

    it("should reject duplicate participant IDs", () => {
      const participants = [
        { participantId: "p1", approved: false, rejected: false },
        { participantId: "p1", approved: false, rejected: false },
      ];
      const result = createConsensusTransaction(1, participants);

      expect(result.status).toBe("error");
      expect(result.error?.code).toBe(SorokitErrorCode.INVALID_CONFIG);
    });

    it("should accept optional metadata", () => {
      const participants = createTestParticipants(3);
      const metadata = { description: "Important decision" };
      const result = createConsensusTransaction(2, participants, {
        metadata,
        transactionId: "tx-123",
      });

      expect(result.status).toBe("ok");
      expect(result.data!.metadata).toEqual(metadata);
      expect(result.data!.transactionId).toBe("tx-123");
    });
  });

  describe("approveConsensusTransaction", () => {
    it("should record an approval", () => {
      const result = approveConsensusTransaction(
        consensusId,
        "participant-1",
        "Looks good",
      );

      expect(result.status).toBe("ok");
      expect(result.data!.approved).toBe(1);
      expect(result.data!.pending).toBe(2);
    });

    it("should transition to REVIEW state on first response", () => {
      let consensus = getConsensusTransaction(consensusId);
      expect(consensus.data!.state).toBe(ConsensusState.PROPOSAL);

      approveConsensusTransaction(consensusId, "participant-1");

      consensus = getConsensusTransaction(consensusId);
      expect(consensus.data!.state).toBe(ConsensusState.REVIEW);
    });

    it("should reject duplicate approvals", () => {
      approveConsensusTransaction(consensusId, "participant-1");
      const result = approveConsensusTransaction(consensusId, "participant-1");

      expect(result.status).toBe("error");
      expect(result.error?.code).toBe(SorokitErrorCode.INVALID_CONFIG);
    });

    it("should reject approval from non-existent participant", () => {
      const result = approveConsensusTransaction(
        consensusId,
        "non-existent-participant",
      );

      expect(result.status).toBe("error");
      expect(result.error?.code).toBe(SorokitErrorCode.INVALID_CONFIG);
    });

    it("should reject approval for non-existent consensus", () => {
      const result = approveConsensusTransaction("non-existent-id", "participant-1");

      expect(result.status).toBe("error");
      expect(result.error?.code).toBe(SorokitErrorCode.INVALID_CONFIG);
    });
  });

  describe("rejectConsensusTransaction", () => {
    it("should record a rejection", () => {
      const result = rejectConsensusTransaction(
        consensusId,
        "participant-1",
        "Not ready",
      );

      expect(result.status).toBe("ok");
      expect(result.data!.rejected).toBe(1);
    });

    it("should move to REJECTED state on rejection", () => {
      rejectConsensusTransaction(consensusId, "participant-1");

      const consensus = getConsensusTransaction(consensusId);
      expect(consensus.data!.state).toBe(ConsensusState.REJECTED);
    });

    it("should reject duplicate rejections", () => {
      rejectConsensusTransaction(consensusId, "participant-1");
      const result = rejectConsensusTransaction(consensusId, "participant-1");

      expect(result.status).toBe("error");
      expect(result.error?.code).toBe(SorokitErrorCode.INVALID_CONFIG);
    });

    it("should reject rejection from non-existent participant", () => {
      const result = rejectConsensusTransaction(
        consensusId,
        "non-existent-participant",
      );

      expect(result.status).toBe("error");
      expect(result.error?.code).toBe(SorokitErrorCode.INVALID_CONFIG);
    });
  });

  describe("threshold and finalization", () => {
    it("should finalize when threshold is reached", () => {
      approveConsensusTransaction(consensusId, "participant-1");
      approveConsensusTransaction(consensusId, "participant-2");

      const result = finalizeConsensusTransaction(consensusId);

      expect(result.status).toBe("ok");
      expect(result.data!.state).toBe(ConsensusState.FINALIZED);
      expect(result.data!.finalizedAt).toBeDefined();
    });

    it("should reject finalization when threshold not met", () => {
      approveConsensusTransaction(consensusId, "participant-1");

      const result = finalizeConsensusTransaction(consensusId);

      expect(result.status).toBe("error");
      expect(result.error?.code).toBe(SorokitErrorCode.INVALID_CONFIG);
    });

    it("should reject finalization if there are rejections", () => {
      approveConsensusTransaction(consensusId, "participant-1");
      approveConsensusTransaction(consensusId, "participant-2");
      rejectConsensusTransaction(consensusId, "participant-3");

      const result = finalizeConsensusTransaction(consensusId);

      expect(result.status).toBe("error");
      expect(result.error?.code).toBe(SorokitErrorCode.INVALID_CONFIG);
    });

    it("should mark transaction as ready when threshold is met", () => {
      approveConsensusTransaction(consensusId, "participant-1");
      approveConsensusTransaction(consensusId, "participant-2");

      const result = getConsensusSummaryResult(consensusId);

      expect(result.status).toBe("ok");
      expect(result.data!.isReady).toBe(true);
    });

    it("should not mark transaction as ready when threshold not met", () => {
      approveConsensusTransaction(consensusId, "participant-1");

      const result = getConsensusSummaryResult(consensusId);

      expect(result.status).toBe("ok");
      expect(result.data!.isReady).toBe(false);
    });
  });

  describe("getConsensusSummary", () => {
    it("should return accurate summary", () => {
      approveConsensusTransaction(consensusId, "participant-1");
      rejectConsensusTransaction(consensusId, "participant-2");

      const result = getConsensusSummaryResult(consensusId);

      expect(result.status).toBe("ok");
      expect(result.data!.approved).toBe(1);
      expect(result.data!.rejected).toBe(1);
      expect(result.data!.pending).toBe(1);
    });

    it("should handle non-existent consensus", () => {
      const result = getConsensusSummaryResult("non-existent");

      expect(result.status).toBe("error");
      expect(result.error?.code).toBe(SorokitErrorCode.INVALID_CONFIG);
    });
  });

  describe("getConsensusTransaction", () => {
    it("should retrieve a consensus transaction", () => {
      const result = getConsensusTransaction(consensusId);

      expect(result.status).toBe("ok");
      expect(result.data!.consensusId).toBe(consensusId);
    });

    it("should handle non-existent consensus", () => {
      const result = getConsensusTransaction("non-existent");

      expect(result.status).toBe("error");
      expect(result.error?.code).toBe(SorokitErrorCode.INVALID_CONFIG);
    });
  });

  describe("removeConsensusTransaction", () => {
    it("should remove a consensus transaction", () => {
      removeConsensusTransaction(consensusId);

      const result = getConsensusTransaction(consensusId);
      expect(result.status).toBe("error");
    });
  });

  describe("full workflow", () => {
    it("should complete a full approval workflow", () => {
      const participants = createTestParticipants(4);
      const consensusResult = createConsensusTransaction(3, participants);
      const id = consensusResult.data!.consensusId;

      // Check initial state
      let summary = getConsensusSummaryResult(id).data!;
      expect(summary.approved).toBe(0);
      expect(summary.isReady).toBe(false);

      // First approval
      approveConsensusTransaction(id, "participant-1");
      summary = getConsensusSummaryResult(id).data!;
      expect(summary.approved).toBe(1);
      expect(summary.isReady).toBe(false);

      // Second approval
      approveConsensusTransaction(id, "participant-2");
      summary = getConsensusSummaryResult(id).data!;
      expect(summary.approved).toBe(2);
      expect(summary.isReady).toBe(false);

      // Third approval - threshold reached
      approveConsensusTransaction(id, "participant-3");
      summary = getConsensusSummaryResult(id).data!;
      expect(summary.approved).toBe(3);
      expect(summary.isReady).toBe(true);

      // Finalize
      const finalizeResult = finalizeConsensusTransaction(id);
      expect(finalizeResult.status).toBe("ok");
      expect(finalizeResult.data!.state).toBe(ConsensusState.FINALIZED);
    });
  });
});
