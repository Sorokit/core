/**
 * Core consensus transaction workflow management.
 * Handles creation, approval tracking, and finalization.
 */

import { randomUUID } from "crypto";
import type {
  ConsensusTransaction,
  ConsensusParticipant,
  ApprovalDecision,
  CreateConsensusOptions,
  ConsensusSummary,
  ConsensusTransactionConfig,
} from "./consensusTypes";
import { ConsensusState } from "./consensusTypes";
import type { SorokitResult } from "../shared/response";
import { SorokitErrorCode, err, ok } from "../shared/response";

/**
 * In-memory store for consensus transactions.
 * In production, this would be persisted to a database.
 */
const consensusStore = new Map<string, ConsensusTransaction>();

/**
 * Validates participant configuration.
 */
function validateParticipants(
  participants: ConsensusParticipant[],
): string | null {
  if (!Array.isArray(participants) || participants.length === 0) {
    return "Participants must be a non-empty array";
  }

  const ids = new Set<string>();
  for (const participant of participants) {
    if (!participant.participantId || typeof participant.participantId !== "string") {
      return "Each participant must have a valid participantId";
    }
    if (ids.has(participant.participantId)) {
      return `Duplicate participant ID: ${participant.participantId}`;
    }
    ids.add(participant.participantId);
  }

  return null;
}

/**
 * Creates a new consensus transaction with threshold and participants.
 */
export function createConsensusTransaction(
  threshold: number,
  participants: ConsensusParticipant[],
  options?: CreateConsensusOptions,
): SorokitResult<ConsensusTransaction> {
  // Validate threshold
  if (!Number.isInteger(threshold) || threshold <= 0) {
    return err<ConsensusTransaction>(
      SorokitErrorCode.INVALID_CONFIG,
      "Threshold must be a positive integer",
    );
  }

  // Validate participants
  const participantError = validateParticipants(participants);
  if (participantError) {
    return err<ConsensusTransaction>(
      SorokitErrorCode.INVALID_CONFIG,
      participantError,
    );
  }

  // Check if threshold is achievable
  if (threshold > participants.length) {
    return err<ConsensusTransaction>(
      SorokitErrorCode.INVALID_CONFIG,
      `Threshold ${threshold} exceeds number of participants ${participants.length}`,
    );
  }

  // Initialize participants map
  const participantsMap = new Map<string, ConsensusParticipant>();
  for (const participant of participants) {
    participantsMap.set(participant.participantId, {
      ...participant,
      approved: false,
      rejected: false,
    });
  }

  const consensus: ConsensusTransaction = {
    consensusId: randomUUID(),
    state: ConsensusState.PROPOSAL,
    threshold,
    totalParticipants: participants.length,
    participants: participantsMap,
    decisions: [],
    createdAt: new Date().toISOString(),
    transactionId: options?.transactionId,
    metadata: options?.metadata,
  };

  consensusStore.set(consensus.consensusId, consensus);
  return ok(consensus);
}

/**
 * Records an approval from a participant.
 */
export function approveConsensusTransaction(
  consensusId: string,
  participantId: string,
  reason?: string,
): SorokitResult<ConsensusSummary> {
  const consensus = consensusStore.get(consensusId);

  if (!consensus) {
    return err<ConsensusSummary>(
      SorokitErrorCode.INVALID_CONFIG,
      `Consensus transaction not found: ${consensusId}`,
    );
  }

  if (!consensus.participants.has(participantId)) {
    return err<ConsensusSummary>(
      SorokitErrorCode.INVALID_CONFIG,
      `Participant not found: ${participantId}`,
    );
  }

  const participant = consensus.participants.get(participantId)!;

  // Check for duplicate approval
  if (participant.approved) {
    return err<ConsensusSummary>(
      SorokitErrorCode.INVALID_CONFIG,
      `Participant ${participantId} has already approved`,
    );
  }

  // Record approval
  participant.approved = true;
  participant.respondedAt = new Date().toISOString();

  consensus.decisions.push({
    participantId,
    decision: true,
    reason,
    timestamp: participant.respondedAt,
  });

  // Update state if needed
  if (consensus.state === ConsensusState.PROPOSAL) {
    consensus.state = ConsensusState.REVIEW;
  }

  return ok(getConsensusSummary(consensus));
}

/**
 * Records a rejection from a participant.
 */
export function rejectConsensusTransaction(
  consensusId: string,
  participantId: string,
  reason?: string,
): SorokitResult<ConsensusSummary> {
  const consensus = consensusStore.get(consensusId);

  if (!consensus) {
    return err<ConsensusSummary>(
      SorokitErrorCode.INVALID_CONFIG,
      `Consensus transaction not found: ${consensusId}`,
    );
  }

  if (!consensus.participants.has(participantId)) {
    return err<ConsensusSummary>(
      SorokitErrorCode.INVALID_CONFIG,
      `Participant not found: ${participantId}`,
    );
  }

  const participant = consensus.participants.get(participantId)!;

  // Check for duplicate rejection
  if (participant.rejected) {
    return err<ConsensusSummary>(
      SorokitErrorCode.INVALID_CONFIG,
      `Participant ${participantId} has already rejected`,
    );
  }

  // Record rejection
  participant.rejected = true;
  participant.respondedAt = new Date().toISOString();

  consensus.decisions.push({
    participantId,
    decision: false,
    reason,
    timestamp: participant.respondedAt,
  });

  // Update state
  if (consensus.state === ConsensusState.PROPOSAL) {
    consensus.state = ConsensusState.REVIEW;
  }

  // If any rejection, move to REJECTED state
  consensus.state = ConsensusState.REJECTED;

  return ok(getConsensusSummary(consensus));
}

/**
 * Gets the current consensus summary.
 */
function getConsensusSummary(consensus: ConsensusTransaction): ConsensusSummary {
  let approved = 0;
  let rejected = 0;

  for (const participant of consensus.participants.values()) {
    if (participant.approved) approved++;
    if (participant.rejected) rejected++;
  }

  const pending = consensus.totalParticipants - approved - rejected;
  const isReady = approved >= consensus.threshold && consensus.state !== ConsensusState.REJECTED;

  return {
    consensusId: consensus.consensusId,
    state: consensus.state,
    threshold: consensus.threshold,
    totalParticipants: consensus.totalParticipants,
    approved,
    rejected,
    pending,
    isReady,
  };
}

/**
 * Retrieves the current summary of a consensus.
 */
export function getConsensusSummaryResult(
  consensusId: string,
): SorokitResult<ConsensusSummary> {
  const consensus = consensusStore.get(consensusId);

  if (!consensus) {
    return err<ConsensusSummary>(
      SorokitErrorCode.INVALID_CONFIG,
      `Consensus transaction not found: ${consensusId}`,
    );
  }

  return ok(getConsensusSummary(consensus));
}

/**
 * Finalizes a consensus transaction after threshold is reached.
 */
export function finalizeConsensusTransaction(
  consensusId: string,
): SorokitResult<ConsensusTransaction> {
  const consensus = consensusStore.get(consensusId);

  if (!consensus) {
    return err<ConsensusTransaction>(
      SorokitErrorCode.INVALID_CONFIG,
      `Consensus transaction not found: ${consensusId}`,
    );
  }

  // Count approvals
  let approved = 0;
  for (const participant of consensus.participants.values()) {
    if (participant.approved) approved++;
  }

  // Check if threshold is met
  if (approved < consensus.threshold) {
    return err<ConsensusTransaction>(
      SorokitErrorCode.INVALID_CONFIG,
      `Cannot finalize: only ${approved} approvals, ${consensus.threshold} required`,
    );
  }

  // Check for rejections
  for (const participant of consensus.participants.values()) {
    if (participant.rejected) {
      return err<ConsensusTransaction>(
        SorokitErrorCode.INVALID_CONFIG,
        `Cannot finalize: proposal has been rejected`,
      );
    }
  }

  consensus.state = ConsensusState.FINALIZED;
  consensus.finalizedAt = new Date().toISOString();

  return ok(consensus);
}

/**
 * Retrieves a consensus transaction.
 */
export function getConsensusTransaction(
  consensusId: string,
): SorokitResult<ConsensusTransaction> {
  const consensus = consensusStore.get(consensusId);

  if (!consensus) {
    return err<ConsensusTransaction>(
      SorokitErrorCode.INVALID_CONFIG,
      `Consensus transaction not found: ${consensusId}`,
    );
  }

  return ok(consensus);
}

/**
 * Removes a consensus transaction (for cleanup/testing).
 */
export function removeConsensusTransaction(consensusId: string): SorokitResult<void> {
  consensusStore.delete(consensusId);
  return ok(undefined);
}
