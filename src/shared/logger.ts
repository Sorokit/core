/**
 * Structured logger for sorokit-core.
 *
 * Off by default. Consumers opt in by passing `logLevel` to createSorokitClient().
 * The logger never writes to a global sink — it is scoped to the client instance.
 */

import type { SorokitResult } from "./response";
import { attachTraceId } from "./response";

export type LogLevel = "off" | "debug" | "info" | "warn" | "error";

export interface StructuredLogMeta extends Record<string, unknown> {
  operation?: string;
  status?: "start" | "ok" | "error";
  errorCode?: string;
  errorMessage?: string;
}

export interface SorokitLogger {
  debug(message: string, meta?: StructuredLogMeta): void;
  info(message: string, meta?: StructuredLogMeta): void;
  warn(message: string, meta?: StructuredLogMeta): void;
  error(message: string, meta?: StructuredLogMeta): void;
  /** Optional correlation ID carried by this logger instance. */
  readonly traceId?: string;
}

export interface LoggerConfig {
  /** Minimum log level to emit. Default: "off" */
  logLevel?: LogLevel;
  /**
   * Enable debug logging. Equivalent to `logLevel: "debug"`.
   * @deprecated Prefer `logLevel: "debug"`
   */
  debug?: boolean;
  /** Custom logger — overrides the built-in console logger */
  logger?: SorokitLogger;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  off: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

/** No-op logger — used when logging is off */
const noopLogger: SorokitLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function resolveLogLevel(config?: LoggerConfig | boolean): LogLevel {
  if (typeof config === "boolean") {
    return config ? "debug" : "off";
  }
  if (config?.logger) {
    return config.logLevel ?? (config.debug ? "debug" : "off");
  }
  if (config?.logLevel) return config.logLevel;
  if (config?.debug) return "debug";
  return "off";
}

function formatStructuredEntry(
  level: LogLevel,
  message: string,
  meta?: StructuredLogMeta,
): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...meta,
  };
}

/** Console logger with level filtering and structured output */
function createConsoleLogger(
  minLevel: LogLevel,
  prefix = "[sorokit]",
): SorokitLogger {
  const shouldLog = (msgLevel: LogLevel): boolean =>
    minLevel !== "off" && LEVEL_PRIORITY[msgLevel] >= LEVEL_PRIORITY[minLevel];

  const write =
    (
      msgLevel: LogLevel,
      consoleFn: (message?: unknown, ...optionalParams: unknown[]) => void,
    ) =>
    (message: string, meta?: StructuredLogMeta): void => {
      if (!shouldLog(msgLevel)) return;
      const entry = formatStructuredEntry(msgLevel, message, meta);
      consoleFn(prefix, entry);
    };

  return {
    debug: write("debug", console.debug),
    info: write("info", console.info),
    warn: write("warn", console.warn),
    error: write("error", console.error),
  };
}

/**
 * Wrap a logger so every emitted entry carries the given trace ID, and expose
 * the trace ID on the returned logger (read by {@link withLogging} to stamp
 * error results). The original logger is left untouched.
 */
export function createTracedLogger(
  logger: SorokitLogger,
  traceId: string,
): SorokitLogger {
  return {
    traceId,
    debug: (message, meta) => logger.debug(message, { traceId, ...meta }),
    info: (message, meta) => logger.info(message, { traceId, ...meta }),
    warn: (message, meta) => logger.warn(message, { traceId, ...meta }),
    error: (message, meta) => logger.error(message, { traceId, ...meta }),
  };
}

/**
 * Create a logger instance.
 * Pass a custom implementation to redirect logs to your own sink.
 */
export function createLogger(
  config?: LoggerConfig | boolean,
  custom?: SorokitLogger,
): SorokitLogger {
  if (custom) return custom;
  if (typeof config === "object" && config?.logger) return config.logger;

  const logLevel = resolveLogLevel(config);
  if (logLevel === "off") return noopLogger;
  return createConsoleLogger(logLevel);
}

/**
 * Log the start and result of an async SDK operation.
 * Emits debug on start, info on success, warn on handled errors.
 */
export async function withLogging<T>(
  logger: SorokitLogger,
  operation: string,
  context: Record<string, unknown> | undefined,
  fn: () => Promise<SorokitResult<T>>,
): Promise<SorokitResult<T>> {
  logger.debug(operation, { operation, status: "start", ...context });

  const raw = await fn();
  // Stamp the logger's trace ID onto error results so callers can correlate
  // failures with the logged operation chain.
  const result =
    logger.traceId !== undefined ? attachTraceId(raw, logger.traceId) : raw;

  if (result.status === "ok") {
    logger.info(operation, { operation, status: "ok", ...context });
  } else {
    logger.warn(operation, {
      operation,
      status: "error",
      errorCode: result.error.code,
      errorMessage: result.error.message,
      traceId: result.error.traceId,
      ...context,
    });
  }

  return result;
}
