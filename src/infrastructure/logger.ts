/**
 * Structured logging with operation context.
 *
 * Replaces scattered console.log calls with named loggers that attach
 * consistent context (operationId, publicKey, network, timestamp) to every
 * entry, and can be pointed at different formatters/transports per
 * environment.
 *
 * Usage:
 *   const logger = createLogger("account", "debug");
 *   logger.info("Fetching account", { publicKey, network: "testnet" });
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const SENSITIVE_KEY_PATTERN = /secret|seed|private|mnemonic|password|authorization/i;

/** Well-known context fields every log entry carries when supplied; arbitrary extra fields are allowed too. */
export interface LogContext {
  operationId?: string;
  publicKey?: string;
  network?: string;
  [key: string]: unknown;
}

/** A single structured log entry passed to formatters and transports. */
export interface LogEntry extends LogContext {
  level: LogLevel;
  name: string;
  message: string;
  timestamp: string;
}

export type LogFormatterName = "json" | "text" | "color";
export type LogFormatter = (entry: LogEntry) => string;

/** A sink that receives every formatted log line. */
export interface LogTransport {
  write(entry: LogEntry, formatted: string): void;
}

export interface Logger {
  readonly name: string;
  readonly level: LogLevel;
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

export interface LoggerOptions {
  /** Named formatter, or a custom function. Defaults to "json". */
  formatter?: LogFormatterName | LogFormatter;
  /** Where formatted entries are sent. Defaults to a single console transport. */
  transports?: LogTransport[];
  /** Context merged into every entry this logger emits (e.g. a fixed network or operationId). */
  context?: LogContext;
}

function redactContext(context: LogContext): LogContext {
  const redacted: LogContext = {};
  for (const [key, value] of Object.entries(context)) {
    redacted[key] = SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED]" : value;
  }
  return redacted;
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const JSON_FORMATTER: LogFormatter = (entry) => JSON.stringify(entry);

const TEXT_FORMATTER: LogFormatter = (entry) => {
  const { level, name, message, timestamp, ...rest } = entry;
  const fields = Object.entries(rest)
    .map(([key, value]) => `${key}=${stringifyValue(value)}`)
    .join(" ");
  return `[${timestamp}] ${level.toUpperCase()} (${name}): ${message}${fields ? ` ${fields}` : ""}`;
};

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};
const COLOR_RESET = "\x1b[0m";

const COLOR_FORMATTER: LogFormatter = (entry) => {
  const color = LEVEL_COLOR[entry.level];
  return `${color}${TEXT_FORMATTER(entry)}${COLOR_RESET}`;
};

const NAMED_FORMATTERS: Record<LogFormatterName, LogFormatter> = {
  json: JSON_FORMATTER,
  text: TEXT_FORMATTER,
  color: COLOR_FORMATTER,
};

function resolveFormatter(formatter: LoggerOptions["formatter"]): LogFormatter {
  if (typeof formatter === "function") return formatter;
  return NAMED_FORMATTERS[formatter ?? "json"];
}

const CONSOLE_METHOD: Record<LogLevel, (...args: unknown[]) => void> = {
  debug: (...args) => console.debug(...args),
  info: (...args) => console.info(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
};

/** Transport that writes each formatted entry to the console via the matching level method. */
export function createConsoleTransport(): LogTransport {
  return {
    write(entry, formatted) {
      CONSOLE_METHOD[entry.level](formatted);
    },
  };
}

/**
 * Transport that appends each formatted entry as a line to a file.
 * Node-only — importing `fs` lazily keeps this module safe to bundle for browsers
 * that never construct a file transport.
 */
export function createFileTransport(filePath: string): LogTransport {
  const fs = require("fs") as typeof import("fs");
  return {
    write(_entry, formatted) {
      fs.appendFileSync(filePath, formatted + "\n");
    },
  };
}

/** Minimal shape of an external error-tracking sink (e.g. Sentry's `captureMessage`/`captureException`). */
export interface ExternalLogSink {
  captureMessage(message: string, level: LogLevel, context?: LogContext): void;
}

/** Transport that forwards `warn`/`error` entries to an external sink such as Sentry. */
export function createExternalTransport(
  sink: ExternalLogSink,
  minLevel: LogLevel = "warn",
): LogTransport {
  return {
    write(entry) {
      if (LOG_LEVEL_PRIORITY[entry.level] < LOG_LEVEL_PRIORITY[minLevel]) return;
      const { level, name, message, timestamp, ...context } = entry;
      sink.captureMessage(message, level, { ...context, logger: name, timestamp });
    },
  };
}

/**
 * Create a named, level-filtered logger.
 *
 * @param name - Logger name, attached to every entry (e.g. "account", "wallet").
 * @param level - Minimum level emitted; calls below this level are no-ops. Defaults to "info".
 * @param options - Formatter, transports, and default context.
 */
export function createLogger(
  name: string,
  level: LogLevel = "info",
  options: LoggerOptions = {},
): Logger {
  const formatter = resolveFormatter(options.formatter);
  const transports = options.transports?.length ? options.transports : [createConsoleTransport()];
  const baseContext = options.context ?? {};

  const emit = (entryLevel: LogLevel, message: string, context?: LogContext): void => {
    if (LOG_LEVEL_PRIORITY[entryLevel] < LOG_LEVEL_PRIORITY[level]) return;

    const entry: LogEntry = {
      ...redactContext(baseContext),
      ...redactContext(context ?? {}),
      level: entryLevel,
      name,
      message,
      timestamp: new Date().toISOString(),
    };
    const formatted = formatter(entry);
    for (const transport of transports) {
      transport.write(entry, formatted);
    }
  };

  return {
    name,
    level,
    debug: (message, context) => emit("debug", message, context),
    info: (message, context) => emit("info", message, context),
    warn: (message, context) => emit("warn", message, context),
    error: (message, context) => emit("error", message, context),
  };
}
