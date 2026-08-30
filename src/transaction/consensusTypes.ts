/**
 * Multi-party transaction consensus types and workflow management.
 * Coordinates N-of-M approval workflows for transactions.
 */

/**
 * Consensus state for a transaction proposal.
 */
export enum ConsensusState {
  PROPOSAL = "proposal",
  REVIEW = "review",
  APPROVED = "approved",
  REJECTED = "rejected",
  FINALIZED = "finalized",
}

/**
 * Participant in a consensus workflow.
 */
export interface ConsensusParticipant {
  /** Unique identifier for the participant */
  participantId: string;
  /** Display name or description */
  name?: string;
  /** Whether participant has approved */
  approved: boolean;
  /** Whether participant has rejected */
  rejected: boolean;
  /** Timestamp of approval/rejection (if applicable) */
  respondedAt?: string;
}

/**
 * Approval decision from a participant.
 */
export interface ApprovalDecision {
  /** Participant ID making the decision */
  participantId: string;
  /** Decision: true for approval, false for rejection */
  decision: boolean;
  /** Optional reason for decision */
  reason?: string;
  /** Timestamp of decision */
  timestamp: string;
}

/**
 * Configuration for creating a consensus transaction.
 */
export interface ConsensusTransactionConfig {
  /** Required number of approvals to reach consensus */
  threshold: number;
  /** List of participants required to approve */
  participants: ConsensusParticipant[];
  /** Optional transaction ID for linking to actual transaction */
  transactionId?: string;
  /** Optional metadata about the transaction */
  metadata?: Record<string, unknown>;
}

/**
 * Represents a consensus workflow around a transaction proposal.
 */
export interface ConsensusTransaction {
  /** Unique identifier for this consensus */
  consensusId: string;
  /** Current state of the consensus */
  state: ConsensusState;
  /** Required threshold for approval */
  threshold: number;
  /** Total number of participants */
  totalParticipants: number;
  /** Participants and their approval status */
  participants: Map<string, ConsensusParticipant>;
  /** List of approval decisions in order */
  decisions: ApprovalDecision[];
  /** Timestamp when consensus was created */
  createdAt: string;
  /** Timestamp when consensus was finalized (if applicable) */
  finalizedAt?: string;
  /** Optional linked transaction ID */
  transactionId?: string;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Summary of consensus status.
 */
export interface ConsensusSummary {
  consensusId: string;
  state: ConsensusState;
  threshold: number;
  totalParticipants: number;
  approved: number;
  rejected: number;
  pending: number;
  isReady: boolean;
  reason?: string;
}

/**
 * Options for creating consensus transaction.
 */
export interface CreateConsensusOptions {
  /** Optional transaction ID to link */
  transactionId?: string;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}
