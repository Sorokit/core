export type LogLevel = "off" | "debug" | "info" | "warn" | "error";

export interface StructuredLogMeta {
  [key: string]: unknown;
}

export interface StructuredLogRecord {
  timestamp: string;
  level: Exclude<LogLevel, "off">;
  module: string;
  message: string;
  context?: StructuredLogMeta;
}

export interface LogTransport {
  write(record: StructuredLogRecord): void | Promise<void>;
}

export interface SorokitLogger {
  debug(message: string, meta?: StructuredLogMeta): void;
  info(message: string, meta?: StructuredLogMeta): void;
  warn(message: string, meta?: StructuredLogMeta): void;
  error(message: string, meta?: StructuredLogMeta): void;
}

export interface TracedLogger extends SorokitLogger {
  readonly traceId?: string;
  readonly spanId?: string;
}

export interface LoggerOptions {
  logLevel?: LogLevel;
  debug?: boolean;
  logger?: SorokitLogger;
  /**
   * Prefix prepended to every console log line for the built-in logger.
   * Defaults to `"[sorokit]"`. Ignored when a custom `logger` is provided.
   * Useful for distinguishing multiple client instances (e.g. `"[sorokit:testnet]"`).
   */
  prefix?: string;
  moduleLevels?: Record<string, LogLevel>;
  transports?: LogTransport[];
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  off: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

const SENSITIVE_KEY_PATTERN = /secret|seed|private|signature|token|passphrase|mnemonic|password/i;
const registeredTransports: LogTransport[] = [];

export function registerLogTransport(transport: LogTransport): () => void {
  registeredTransports.push(transport);
  return () => {
    const index = registeredTransports.indexOf(transport);
    if (index >= 0) registeredTransports.splice(index, 1);
  };
}

/**
 * Remove query parameters and fragments from a URL before it is written to a
 * log. The original URL is never modified; this function only returns the
 * value suitable for logging.
 */
export function sanitizeUrlForLogging(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    // URL values supplied to the client are validated before use. Keep this
    // fallback defensive for callers using the logger directly.
    const queryIndex = url.search(/[?#]/);
    return queryIndex === -1 ? url : url.slice(0, queryIndex);
  }
}

export function sanitizeLogMeta(meta?: StructuredLogMeta): StructuredLogMeta | undefined {
  if (!meta) return undefined;

  const sanitized: StructuredLogMeta = { ...meta };
  for (const [key, value] of Object.entries(sanitized)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      sanitized[key] = "[redacted]";
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      sanitized[key] = sanitizeLogMeta(value as StructuredLogMeta);
    }
  }
  for (const key of ["horizonUrl", "rpcUrl"]) {
    const value = sanitized[key];
    if (typeof value === "string") {
      sanitized[key] = sanitizeUrlForLogging(value);
    }
  }
  return sanitized;
}

export function createConsoleTransport(prefix = "[sorokit]"): LogTransport {
  return {
    write(record) {
      const method = record.level === "debug" ? console.debug : record.level === "info"
        ? console.info
        : record.level === "warn"
          ? console.warn
          : console.error;
      method(prefix, record);
    },
  };
}

function resolveModule(meta?: StructuredLogMeta): string {
  const moduleName = meta?.module ?? meta?.operation;
  return typeof moduleName === "string" && moduleName.length > 0 ? moduleName : "core";
}

function createTransportLogger(resolveTransports: () => LogTransport[]): SorokitLogger {
  const emit = (level: Exclude<LogLevel, "off">, message: string, meta?: StructuredLogMeta): void => {
    const sanitized = sanitizeLogMeta(meta);
    const record: StructuredLogRecord = {
      timestamp: new Date().toISOString(),
      level,
      module: resolveModule(sanitized),
      message,
      ...(sanitized ? { context: sanitized } : {}),
    };
    for (const transport of resolveTransports()) {
      void transport.write(record);
    }
  };

  return {
    debug: (message, meta) => emit("debug", message, meta),
    info: (message, meta) => emit("info", message, meta),
    warn: (message, meta) => emit("warn", message, meta),
    error: (message, meta) => emit("error", message, meta),
  };
}

function createNoopLogger(): SorokitLogger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

function createLevelLogger(
  level: LogLevel,
  sink: SorokitLogger,
  moduleLevels?: Record<string, LogLevel>,
): SorokitLogger {
  const shouldLog = (
    methodLevel: Exclude<LogLevel, "off">,
    meta?: StructuredLogMeta,
  ): boolean => {
    const moduleLevel = moduleLevels?.[resolveModule(meta)];
    const threshold = LOG_LEVEL_PRIORITY[moduleLevel ?? level];
    return threshold >= LOG_LEVEL_PRIORITY[methodLevel];
  };
  return {
    debug: (message, meta) => {
      if (shouldLog("debug", meta)) sink.debug(message, sanitizeLogMeta(meta));
    },
    info: (message, meta) => {
      if (shouldLog("info", meta)) sink.info(message, sanitizeLogMeta(meta));
    },
    warn: (message, meta) => {
      if (shouldLog("warn", meta)) sink.warn(message, sanitizeLogMeta(meta));
    },
    error: (message, meta) => {
      if (shouldLog("error", meta)) sink.error(message, sanitizeLogMeta(meta));
    },
  };
}

/** Create a level-filtered logger. Logging is disabled by default. */
export function createLogger(options?: LoggerOptions): SorokitLogger {
  const level: LogLevel = options?.logLevel ?? (options?.debug ? "debug" : "off");
  if (level === "off") return createNoopLogger();
  const ownTransports = options?.transports ?? [];
  // Registered transports are resolved per emit so that unregister() takes effect
  // for loggers created before the transport was removed.
  const resolveTransports = (): LogTransport[] => {
    const transports = [...ownTransports, ...registeredTransports];
    return transports.length > 0 ? transports : [createConsoleTransport(options?.prefix)];
  };
  const sink = options?.logger ?? createTransportLogger(resolveTransports);
  return createLevelLogger(level, sink, options?.moduleLevels);
}

/** Add trace identifiers to all entries emitted by a logger. */
export function createTracedLogger(
  logger: SorokitLogger,
  traceContext: string | { traceId?: string; spanId?: string } | null | undefined,
): TracedLogger {
  const normalizedContext =
    typeof traceContext === "string" ? { traceId: traceContext } : traceContext;
  const traceMeta: StructuredLogMeta = {};
  if (normalizedContext?.traceId !== undefined) traceMeta.traceId = normalizedContext.traceId;
  if (normalizedContext?.spanId !== undefined) traceMeta.spanId = normalizedContext.spanId;

  const withTrace = (meta?: StructuredLogMeta): StructuredLogMeta => ({ ...traceMeta, ...meta });
  return {
    ...(normalizedContext?.traceId !== undefined ? { traceId: normalizedContext.traceId } : {}),
    ...(normalizedContext?.spanId !== undefined ? { spanId: normalizedContext.spanId } : {}),
    debug: (message, meta) => logger.debug(message, withTrace(meta)),
    info: (message, meta) => logger.info(message, withTrace(meta)),
    warn: (message, meta) => logger.warn(message, withTrace(meta)),
    error: (message, meta) => logger.error(message, withTrace(meta)),
  };
}

/**
 * Log the start and result of an async SDK operation.
 * Emits debug on start, info on success, warn on handled errors.
 */
export async function withLogging<T>(
  logger: TracedLogger,
  operation: string,
  meta: StructuredLogMeta,
  fn: () => Promise<T>,
): Promise<T> {
  logger.debug(operation, { ...meta, operation, status: "start" });
  try {
    const result = await fn();
    const resultStatus =
      typeof result === "object" && result !== null && "status" in result
        ? (result as { status?: unknown }).status
        : undefined;
    const statusMeta = {
      ...meta,
      operation,
      status: resultStatus === "error" ? "error" : "ok",
    };
    if (resultStatus === "error" && typeof result === "object" && result !== null && "error" in result) {
      const errorResult = result as unknown as {
        status: "error";
        data: null;
        error: { code: string; message: string; traceId?: string };
      };
      logger.error(operation, {
        ...statusMeta,
        errorCode: errorResult.error.code,
        errorMessage: errorResult.error.message,
      });
      if (logger.traceId !== undefined && errorResult.error.traceId === undefined) {
        return {
          ...errorResult,
          error: { ...errorResult.error, traceId: logger.traceId },
        } as T;
      }
      return result;
    }
    logger.debug(operation, statusMeta);
    return result;
  } catch (cause) {
    logger.error(operation, {
      ...meta,
      operation,
      status: "error",
      errorMessage: cause instanceof Error ? cause.message : String(cause),
    });
    throw cause;
  }
}
