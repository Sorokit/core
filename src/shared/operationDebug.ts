import type { SorokitLogger, StructuredLogMeta } from "./logger";

export interface OperationDebugger {
  readonly operationId: string;
  /** Log at debug level, tagged with the operation ID. No-op when the logger's level is above debug. */
  log(message: string, meta?: StructuredLogMeta): void;
  /** Log a network request or response. Query strings are stripped from `url`. */
  network(direction: "request" | "response", url: string, meta?: StructuredLogMeta): void;
}

let counter = 0;

/**
 * Create a debug helper for one SDK operation. Entries carry `operation` and
 * `operationId` (the logger adds the timestamp). Sensitive keys such as
 * secrets and signatures are redacted by the logger's sanitizer.
 */
export function createOperationDebugger(logger: SorokitLogger, operation: string): OperationDebugger {
  const operationId = `${operation}-${(counter++).toString(36)}`;
  const base = { operation, operationId };
  return {
    operationId,
    log: (message, meta) => logger.debug(`[${operationId}] ${message}`, { ...base, ...meta }),
    network: (direction, url, meta) => {
      const clean = url.split(/[?#]/)[0];
      logger.debug(`[${operationId}] network ${direction} ${clean}`, { ...base, ...meta });
    },
  };
}
