/**
 * Minimal structured logger for sorokit-core.
 *
 * Off by default. Consumers opt in by passing `debug: true` to
 * createSorokitClient(). The logger never writes to a global sink —
 * it is scoped to the client instance.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface SorokitLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** No-op logger — used when debug mode is off */
const noopLogger: SorokitLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Console logger — used when debug mode is on */
function createConsoleLogger(prefix = "[sorokit]"): SorokitLogger {
  return {
    debug: (msg, meta) => console.debug(`${prefix} ${msg}`, meta ?? ""),
    info: (msg, meta) => console.info(`${prefix} ${msg}`, meta ?? ""),
    warn: (msg, meta) => console.warn(`${prefix} ${msg}`, meta ?? ""),
    error: (msg, meta) => console.error(`${prefix} ${msg}`, meta ?? ""),
  };
}

/**
 * Create a logger instance.
 * Pass a custom implementation to redirect logs to your own sink.
 */
export function createLogger(
  debug: boolean,
  custom?: SorokitLogger,
): SorokitLogger {
  if (custom) return custom;
  if (debug) return createConsoleLogger();
  return noopLogger;
}
