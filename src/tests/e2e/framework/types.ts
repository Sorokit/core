/**
 * Shared result types for the E2E workflow framework (#issue: E2E integration
 * testing framework). Every workflow runner returns one of these so scenarios
 * can be composed, reported, and asserted on uniformly regardless of what
 * they exercise (wallet connection, multi-sig collection, network failover).
 */

export type WorkflowStepStatus = "ok" | "error" | "skipped";

export interface WorkflowStepResult {
  step: string;
  status: WorkflowStepStatus;
  durationMs: number;
  detail?: string;
}

export interface WorkflowResult {
  workflow: string;
  ok: boolean;
  steps: WorkflowStepResult[];
}
