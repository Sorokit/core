/**
 * Multi-Contract Sequence Executor with Dependency Tracking
 *
 * Executes multiple contract calls with dependency tracking, ensuring
 * dependent calls run after their dependencies and state is threaded
 * between calls.
 */

import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { PreparedContractCall } from "./types";

/**
 * A single step in the contract sequence.
 */
export interface ContractSequenceStep {
  /** Unique identifier for this step */
  id: string;
  /** Prepared contract call ready for execution */
  call: PreparedContractCall;
  /** IDs of steps this step depends on */
  dependencies: string[];
}

/**
 * Result of executing a single sequence step.
 */
export interface StepExecutionResult {
  /** Step ID */
  id: string;
  /** Execution status */
  status: "success" | "error";
  /** Transaction hash if successful */
  txHash?: string;
  /** Error message if failed */
  error?: string;
  /** Output state to pass to dependent steps */
  output?: unknown;
}

/**
 * Result of executing the entire sequence.
 */
export interface SequenceExecutionResult {
  /** Overall execution status */
  status: "success" | "partial" | "failed";
  /** Results for each step */
  steps: StepExecutionResult[];
  /** Final error if sequence failed */
  error?: string;
}

/**
 * Configuration for sequence execution.
 */
export interface SequenceExecutionConfig {
  /** Function to execute a prepared call and return tx hash */
  executeFn: (call: PreparedContractCall, input?: unknown) => Promise<{ txHash: string; output?: unknown }>;
}

/**
 * Error types for dependency validation.
 */
export enum DependencyErrorType {
  CIRCULAR_DEPENDENCY = "CIRCULAR_DEPENDENCY",
  MISSING_DEPENDENCY = "MISSING_DEPENDENCY",
  SELF_DEPENDENCY = "SELF_DEPENDENCY",
}

/**
 * Result of dependency validation.
 */
export interface DependencyValidationResult {
  /** Whether dependencies are valid */
  valid: boolean;
  /** Error type if invalid */
  errorType?: DependencyErrorType;
  /** Error message */
  message?: string;
  /** Detected cycle (for circular dependencies) */
  cycle?: string[];
}

/**
 * Contract Sequence Executor
 *
 * Manages execution of multiple contract calls with dependency tracking.
 */
export class ContractSequencer {
  private steps: Map<string, ContractSequenceStep> = new Map();
  private executionOrder: string[] = [];

  /**
   * Add a step to the sequence.
   *
   * @param id           - Unique identifier for this step
   * @param call         - Prepared contract call
   * @param dependencies - IDs of steps this step depends on
   * @returns The sequencer instance for chaining
   */
  add(
    id: string,
    call: PreparedContractCall,
    dependencies: string[] = [],
  ): ContractSequencer {
    if (this.steps.has(id)) {
      throw new Error(`Step with id '${id}' already exists`);
    }

    // Check for self-dependency
    if (dependencies.includes(id)) {
      throw new Error(`Step '${id}' cannot depend on itself`);
    }

    this.steps.set(id, { id, call, dependencies });
    return this;
  }

  /**
   * Validate the dependency graph.
   *
   * @returns Validation result
   */
  validateDependencies(): DependencyValidationResult {
    const steps = Array.from(this.steps.values());
    const stepIds = new Set(this.steps.keys());

    // Check for missing dependencies
    for (const step of steps) {
      for (const dep of step.dependencies) {
        if (!stepIds.has(dep)) {
          return {
            valid: false,
            errorType: DependencyErrorType.MISSING_DEPENDENCY,
            message: `Step '${step.id}' depends on non-existent step '${dep}'`,
          };
        }
      }
    }

    // Check for circular dependencies using DFS
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const cycle: string[] = [];

    const hasCycle = (stepId: string, path: string[]): boolean => {
      visited.add(stepId);
      recursionStack.add(stepId);
      path.push(stepId);

      const step = this.steps.get(stepId);
      if (step) {
        for (const dep of step.dependencies) {
          if (!visited.has(dep)) {
            if (hasCycle(dep, path)) {
              return true;
            }
          } else if (recursionStack.has(dep)) {
            // Found a cycle
            const cycleStart = path.indexOf(dep);
            cycle.push(...path.slice(cycleStart), dep);
            return true;
          }
        }
      }

      recursionStack.delete(stepId);
      path.pop();
      return false;
    };

    for (const stepId of stepIds) {
      if (!visited.has(stepId)) {
        if (hasCycle(stepId, [])) {
          return {
            valid: false,
            errorType: DependencyErrorType.CIRCULAR_DEPENDENCY,
            message: `Circular dependency detected: ${cycle.join(" -> ")}`,
            cycle,
          };
        }
      }
    }

    return { valid: true };
  }

  /**
   * Compute topological order of steps.
   *
   * @returns Array of step IDs in execution order
   */
  private computeTopologicalOrder(): string[] {
    const inDegree = new Map<string, number>();
    const stepIds = Array.from(this.steps.keys());

    // Initialize in-degrees
    for (const id of stepIds) {
      inDegree.set(id, 0);
    }

    // Count in-degrees
    for (const step of this.steps.values()) {
      for (const dep of step.dependencies) {
        inDegree.set(dep, (inDegree.get(dep) || 0) + 1);
      }
    }

    // Kahn's algorithm for topological sort
    const queue: string[] = [];
    const order: string[] = [];

    // Start with nodes that have no incoming edges
    for (const [id, degree] of inDegree) {
      if (degree === 0) {
        queue.push(id);
      }
    }

    while (queue.length > 0) {
      const current = queue.shift()!;
      order.push(current);

      const step = this.steps.get(current);
      if (step) {
        for (const dep of step.dependencies) {
          inDegree.set(dep, (inDegree.get(dep) || 0) - 1);
          if (inDegree.get(dep) === 0) {
            queue.push(dep);
          }
        }
      }
    }

    return order;
  }

  /**
   * Execute the sequence.
   *
   * @param config - Execution configuration
   * @returns Execution result
   */
  async execute(config: SequenceExecutionConfig): Promise<SorokitResult<SequenceExecutionResult>> {
    // Validate dependencies first
    const validation = this.validateDependencies();
    if (!validation.valid) {
      return err(
        SorokitErrorCode.VALIDATION,
        validation.message || "Dependency validation failed",
      );
    }

    // Compute execution order
    this.executionOrder = this.computeTopologicalOrder();

    const stepResults: StepExecutionResult[] = [];
    const stepOutputs: Map<string, unknown> = new Map();

    // Execute steps in order
    for (const stepId of this.executionOrder) {
      const step = this.steps.get(stepId);
      if (!step) {
        return err(
          SorokitErrorCode.INTERNAL,
          `Step '${stepId}' not found during execution`,
        );
      }

      // Gather inputs from dependencies
      const inputs: unknown[] = [];
      for (const depId of step.dependencies) {
        const output = stepOutputs.get(depId);
        if (output === undefined) {
          return err(
            SorokitErrorCode.INTERNAL,
            `Dependency '${depId}' did not produce output for step '${stepId}'`,
          );
        }
        inputs.push(output);
      }

      // Execute the step
      try {
        const result = await config.executeFn(step.call, inputs.length > 0 ? inputs : undefined);
        
        const stepResult: StepExecutionResult = {
          id: stepId,
          status: "success",
          txHash: result.txHash,
          output: result.output,
        };
        
        stepResults.push(stepResult);
        stepOutputs.set(stepId, result.output);
      } catch (cause) {
        const errorMessage = cause instanceof Error ? cause.message : String(cause);
        
        const stepResult: StepExecutionResult = {
          id: stepId,
          status: "error",
          error: errorMessage,
        };
        
        stepResults.push(stepResult);

        // Stop on first error
        return ok({
          status: "partial",
          steps: stepResults,
          error: `Step '${stepId}' failed: ${errorMessage}`,
        });
      }
    }

    return ok({
      status: "success",
      steps: stepResults,
    });
  }

  /**
   * Get the current execution order.
   *
   * @returns Array of step IDs in execution order
   */
  getExecutionOrder(): string[] {
    return [...this.executionOrder];
  }

  /**
   * Get all step IDs.
   *
   * @returns Array of step IDs
   */
  getStepIds(): string[] {
    return Array.from(this.steps.keys());
  }

  /**
   * Clear all steps from the sequencer.
   */
  clear(): void {
    this.steps.clear();
    this.executionOrder = [];
  }

  /**
   * Get the number of steps in the sequence.
   *
   * @returns Number of steps
   */
  size(): number {
    return this.steps.size;
  }
}

/**
 * Convenience function to create and execute a sequence in one call.
 *
 * @param steps  - Array of step definitions
 * @param config - Execution configuration
 * @returns Execution result
 */
export async function executeSequence(
  steps: Array<{ id: string; call: PreparedContractCall; dependencies?: string[] }>,
  config: SequenceExecutionConfig,
): Promise<SorokitResult<SequenceExecutionResult>> {
  const sequencer = new ContractSequencer();

  for (const step of steps) {
    sequencer.add(step.id, step.call, step.dependencies || []);
  }

  return sequencer.execute(config);
}
