import {
  err,
  ok,
  SorokitErrorCode,
} from "../shared/response";
import type { SorokitResult } from "../shared/response";

export interface AtomicOrchestratorOptions {
  /** Retries after the initial attempt, applied to each step independently. */
  maxRetries?: number;
  /** Delay between attempts in milliseconds. Defaults to zero. */
  retryDelayMs?: number;
}

export interface AtomicStepContext {
  completedSteps: number;
  results: readonly unknown[];
}

export interface AtomicFailureContext extends AtomicStepContext {
  failedStepIndex: number;
  failure: unknown;
}

export interface AtomicExecutionResult {
  completedSteps: number;
  results: unknown[];
  attemptsByStep: number[];
}

type AtomicStep = (context: AtomicStepContext) => unknown | Promise<unknown>;
type FailureHandler = (
  context: AtomicFailureContext,
) => void | Promise<void>;

function isErrorResult(
  value: unknown,
): value is Extract<SorokitResult<unknown>, { status: "error" }> {
  return typeof value === "object" && value !== null &&
    (value as { status?: unknown }).status === "error";
}

/** Sequential orchestration with caller-provided compensation on failure. */
export class AtomicOrchestrator {
  private readonly steps: AtomicStep[] = [];
  private failureHandler?: FailureHandler;

  constructor(private readonly options: AtomicOrchestratorOptions = {}) {}

  step<T>(
    operation: (context: AtomicStepContext) => T | Promise<T>,
  ): this {
    this.steps.push(operation);
    return this;
  }

  onFailure(handler: FailureHandler): this {
    this.failureHandler = handler;
    return this;
  }

  async execute(): Promise<SorokitResult<AtomicExecutionResult>> {
    const maxRetries = this.options.maxRetries ?? 0;
    const retryDelayMs = this.options.retryDelayMs ?? 0;
    if (
      !Number.isInteger(maxRetries) ||
      maxRetries < 0 ||
      !Number.isFinite(retryDelayMs) ||
      retryDelayMs < 0
    ) {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        "Retry limits must be non-negative finite numbers.",
      );
    }
    if (this.steps.length === 0) {
      return err(
        SorokitErrorCode.INVALID_TRANSACTION,
        "At least one orchestration step is required.",
      );
    }

    const results: unknown[] = [];
    const attemptsByStep: number[] = [];

    for (let stepIndex = 0; stepIndex < this.steps.length; stepIndex += 1) {
      const operation = this.steps[stepIndex]!;
      let failure: unknown;
      let completed = false;

      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        attemptsByStep[stepIndex] = attempt + 1;
        try {
          const result = await operation({
            completedSteps: results.length,
            results: [...results],
          });
          if (isErrorResult(result)) {
            failure = result.error;
            if (attempt < maxRetries && retryDelayMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
            }
            continue;
          }
          results.push(result);
          completed = true;
          break;
        } catch (cause) {
          failure = cause;
          if (attempt < maxRetries && retryDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          }
        }
      }

      if (completed) continue;

      const failureContext: AtomicFailureContext = {
        completedSteps: results.length,
        results: [...results],
        failedStepIndex: stepIndex,
        failure,
      };
      let rollbackFailure: unknown;
      if (this.failureHandler) {
        try {
          await this.failureHandler(failureContext);
        } catch (cause) {
          rollbackFailure = cause;
        }
      }

      return err(
        SorokitErrorCode.TX_SUBMIT_FAILED,
        `Orchestration failed at step ${stepIndex}.`,
        { failure, rollbackFailure, completedSteps: results.length },
        undefined,
        {
          context: {
            operation: "atomicOrchestration",
            parameters: {
              failedStepIndex: stepIndex,
              completedSteps: results.length,
              rollbackFailed: rollbackFailure !== undefined,
            },
          },
          recovery: {
            retryable: rollbackFailure === undefined,
            action:
              rollbackFailure === undefined
                ? "Inspect the failed step, then retry the orchestration if safe."
                : "Inspect both the failed step and rollback failure before retrying.",
          },
        },
      );
    }

    return ok({
      completedSteps: results.length,
      results,
      attemptsByStep,
    });
  }
}

export function orchestrate(
  options: AtomicOrchestratorOptions = {},
): AtomicOrchestrator {
  return new AtomicOrchestrator(options);
}