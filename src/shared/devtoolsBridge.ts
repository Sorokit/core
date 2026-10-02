/**
 * DevTools bridge (#617)
 *
 * A `LogTransport` that forwards every structured log record sorokit-core
 * already produces (see `withLogging` in `logger.ts`) to a `window` event,
 * so a browser extension can observe SDK operations in real time without
 * the SDK needing any extension-specific code beyond this transport.
 *
 * This only forwards what already flows through the logger: operation
 * start/success/error for wallet, account, transaction, and Soroban calls,
 * each carrying whatever metadata the call site passed to `withLogging`
 * (public keys, transaction hashes, error codes, etc.). Registering this
 * transport does not by itself enable logging — the client's `logLevel`
 * (or `debug: true`) still gates whether `withLogging` calls the logger at
 * all, same as any other transport.
 */

import { registerLogTransport } from "./logger";
import type { LogTransport, StructuredLogRecord } from "./logger";

/** Name of the `window` CustomEvent dispatched for every forwarded log record. */
export const SOROKIT_DEVTOOLS_EVENT = "sorokit:devtools";

export interface SorokitDevtoolsEventDetail {
  /** Monotonically increasing per-process sequence number, for ordering in the panel. */
  seq: number;
  record: StructuredLogRecord;
}

let sequence = 0;

function createDevtoolsTransport(): LogTransport {
  return {
    write(record: StructuredLogRecord): void {
      if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") {
        return;
      }
      sequence += 1;
      const detail: SorokitDevtoolsEventDetail = { seq: sequence, record };
      window.dispatchEvent(new CustomEvent<SorokitDevtoolsEventDetail>(SOROKIT_DEVTOOLS_EVENT, { detail }));
    },
  };
}

/**
 * Register the DevTools bridge transport. Call this once, before creating a
 * client with `debug: true` (or an explicit non-"off" `logLevel`), so the
 * sorokit-core browser extension can pick up operations as they happen.
 *
 * No-ops outside a browser environment (`window` undefined), so it's safe
 * to call unconditionally from an app's entry point.
 *
 * @returns A function that unregisters the transport.
 *
 * @example
 * import { enableDevtoolsBridge } from "sorokit-core/shared";
 * import { createSorokitClient } from "sorokit-core";
 *
 * if (process.env.NODE_ENV !== "production") {
 *   enableDevtoolsBridge();
 * }
 * const client = createSorokitClient({ network: "testnet", debug: true });
 */
export function enableDevtoolsBridge(): () => void {
  return registerLogTransport(createDevtoolsTransport());
}
