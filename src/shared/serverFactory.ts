/**
 * Centralized server factory with tracing support (#212).
 *
 * All module functions should use these helpers instead of directly
 * instantiating `Horizon.Server` or `SorobanRpc.Server`. The client
 * factory calls `setTracedFetch` once, and all subsequent server
 * instances automatically inject correlation headers.
 *
 * This avoids having to thread a `fetch` option through every function's
 * parameter list while still supporting custom fetch for tracing.
 */

import { Horizon } from "@stellar/stellar-sdk";
import { rpc as SorobanRpc } from "@stellar/stellar-sdk";
import type { SorobanSimulator } from "../soroban/simulator";
import { getEndpointPool, createFailoverFetch } from "../network/endpointFailover";
import type { ConnectionPool } from "../network/connectionPool";

let tracedFetch: typeof globalThis.fetch | undefined;
let connectionPool: ConnectionPool | undefined;
let activeSimulator: SorobanSimulator | null = null;

/**
 * Set the fetch function to use for all server instances.
 * Called once during `createSorokitClient`.
 */
export function setTracedFetch(fetch: typeof globalThis.fetch): void {
  tracedFetch = fetch;
}

/**
 * Get the currently configured traced fetch, or undefined.
 */
export function getTracedFetch(): typeof globalThis.fetch | undefined {
  return tracedFetch;
}

/** Configure the shared HTTP pool used by subsequently-created servers. */
export function setConnectionPool(pool: ConnectionPool | undefined): void {
  connectionPool = pool;
}

/** Return the currently configured HTTP pool, if one is active. */
export function getConnectionPool(): ConnectionPool | undefined {
  return connectionPool;
}

/**
 * Inject a SorobanSimulator for local testing (#210).
 * When set, createSorobanServer returns the simulator instead of a
 * real SorobanRpc.Server for any URL matching simulator.rpc.
 */
export function setSorobanSimulator(simulator: SorobanSimulator | null): void {
  activeSimulator = simulator;
}

/**
 * Options accepted by the server factories.
 * `signal` aborts in-flight requests when the operation times out (#392).
 */
export interface ServerOptions {
  signal?: AbortSignal | undefined;
}

function endpointAwareFetch(
  endpoint: string,
  signal?: AbortSignal,
): NonNullable<typeof tracedFetch> {
  const base = connectionPool?.fetch ?? tracedFetch ?? globalThis.fetch.bind(globalThis);
  const pool = getEndpointPool(endpoint);
  const fetcher = pool ? createFailoverFetch(pool, base) : base;
  return signal
    ? (input, init) => fetcher(input, {
        ...init,
        signal: composeSignals(init?.signal ?? undefined, signal),
      })
    : fetcher;
}

function composeSignals(
  a: AbortSignal | null | undefined,
  b: AbortSignal,
): AbortSignal {
  if (!a) return b;
  if (a.aborted) return a;
  if (b.aborted) return b;
  const controller = new AbortController();
  const forward = (from: AbortSignal) => () => controller.abort((from as { reason?: unknown }).reason);
  a.addEventListener("abort", forward(a), { once: true });
  b.addEventListener("abort", forward(b), { once: true });
  return controller.signal;
}

/**
 * Create a Horizon.Server instance with optional tracing fetch and
 * optional timeout signal (#392).
 */
export function createHorizonServer(
  horizonUrl: string,
  options?: ServerOptions,
): Horizon.Server {
  const pooledFetch = connectionPool?.fetch;
  if (options?.signal) {
    return new Horizon.Server(horizonUrl, {
      fetch: pooledFetch
        ? (input: RequestInfo | URL, init?: RequestInit) =>
            pooledFetch(input, {
              ...init,
              signal: composeSignals(init?.signal, options.signal!),
            })
        : endpointAwareFetch(horizonUrl, options.signal),
    } as any);
  }
  return pooledFetch || tracedFetch
    ? new Horizon.Server(horizonUrl, { fetch: pooledFetch ?? tracedFetch } as any)
    : new Horizon.Server(horizonUrl);
}

/**
 * Create a SorobanRpc.Server instance with optional tracing fetch and
 * optional timeout signal (#392).
 * If a simulator is active and the URL matches, returns the simulator.
 */
export function createSorobanServer(
  rpcUrl: string,
  options?: ServerOptions,
): SorobanRpc.Server | SorobanSimulator {
  if (activeSimulator && rpcUrl === activeSimulator.rpc) {
    return activeSimulator;
  }
  const pooledFetch = connectionPool?.fetch;
  if (options?.signal) {
    return new SorobanRpc.Server(rpcUrl, {
      fetch: pooledFetch
        ? (input: RequestInfo | URL, init?: RequestInit) =>
            pooledFetch(input, {
              ...init,
              signal: composeSignals(init?.signal, options.signal!),
            })
        : endpointAwareFetch(rpcUrl, options.signal),
    } as any);
  }
  return pooledFetch || tracedFetch
    ? new SorobanRpc.Server(rpcUrl, { fetch: pooledFetch ?? tracedFetch } as any)
    : new SorobanRpc.Server(rpcUrl);
}
