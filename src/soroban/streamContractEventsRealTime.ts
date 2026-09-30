/**
 * Real-time Soroban contract event streaming (#541).
 *
 * Polls the Soroban RPC `getEvents` endpoint using a forward cursor,
 * applying exponential backoff with jitter on transient failures and
 * hash-based deduplication so events crossing ledger/cursor boundaries are
 * never yielded twice. Backoff resets on every successful poll.
 *
 * The generator runs until the caller breaks out of the `for await` loop or
 * the provided `AbortSignal` is aborted. After `maxAttempts` consecutive
 * RPC failures the stream throws the last error; transient hiccups shorter
 * than that are absorbed by the backoff.
 */

import { rpc as SorobanRpc } from "@stellar/stellar-sdk";
import { createSorobanServer } from "../shared/serverFactory";
import { computeBackoffDelay } from "../shared/utils";
import { toMessage } from "../shared/errors";
import type { ContractEvent } from "./subscribeContractEvents";
import { EventIndex, filterNewEvents } from "./eventIndex";

export interface StreamContractEventsRealTimeOptions {
  /** Base URL of the Soroban RPC server. */
  rpcUrl: string;
  /**
   * Ledger sequence to start querying from (inclusive). When omitted, the
   * RPC server reports the latest ledger and streaming starts from there.
   */
  startLedger?: number;
  /** Maximum number of events fetched per `getEvents` call (default: 100). */
  limit?: number;
  /** Consecutive RPC failures before the stream stops (default: 8). */
  maxAttempts?: number;
  /** Initial backoff delay in milliseconds (default: 500). */
  backoffInitialMs?: number;
  /** Maximum backoff delay in milliseconds (default: 30_000). */
  backoffMaxMs?: number;
  /** Backoff growth multiplier (default: 2). */
  backoffFactor?: number;
  /** Whether to apply jitter to backoff delays (default: true). */
  jitter?: boolean;
  /** Abort signal that stops the stream cleanly. */
  signal?: AbortSignal;
  /**
   * Optional callback invoked after each failed RPC attempt with the error
   * and the zero-based consecutive-attempt counter. Useful for observability.
   */
  onError?: (error: unknown, attempt: number) => void;
}

const EVENT_INDEX_DEFAULT_MAX = 10_000;

/**
 * Normalize a contract address. RPC responses can surface the contract ID as a
 * plain string or as a stellar-base `Contract` instance; both normalize to a
 * string, falling back to the requested `contractId` otherwise.
 */
function contractAddress(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  if (value && typeof (value as { toString?: () => string }).toString === "function") {
    const normalized = String((value as { toString: () => string }).toString());
    if (normalized.length > 0) return normalized;
  }
  return fallback;
}

function toEvent(
  raw: SorobanRpc.Api.EventResponse,
  contractId: string,
): ContractEvent {
  return {
    id: raw.id,
    contractId: contractAddress(raw.contractId, contractId),
    pagingToken: raw.pagingToken,
    ledger: raw.ledger,
    ledgerClosedAt: raw.ledgerClosedAt,
    txHash: raw.txHash,
    inSuccessfulContractCall: raw.inSuccessfulContractCall,
    type: raw.type,
    topics: raw.topic.map((topic) => topic.toXDR("base64")),
    value: raw.value.toXDR("base64"),
    topic: raw.topic.map((topic) => topic.toXDR("base64")),
  };
}

/**
 * Stream contract events in near real-time over the Soroban RPC endpoint.
 *
 * Events are yielded in batches as new ones appear. Deduplication is
 * hash-based (see `EventIndex`), so a batch never contains an event that was
 * already yielded, even when the RPC node re-reports an earlier cursor.
 *
 * @param contractId - Soroban contract address to monitor.
 * @param options    - RPC URL, backoff tuning, filtering, and abort options.
 * @yields Arrays of new `ContractEvent` objects as they are detected.
 *
 * @example
 * const ac = new AbortController();
 * setTimeout(() => ac.abort(), 60_000);
 * for await (const events of streamContractEventsRealTime(contractId, {
 *   rpcUrl: "https://soroban-testnet.stellar.org",
 *   signal: ac.signal,
 * })) {
 *   console.log("new events:", events);
 * }
 */
export async function* streamContractEventsRealTime(
  contractId: string,
  options: StreamContractEventsRealTimeOptions,
): AsyncGenerator<ContractEvent[]> {
  const server = createSorobanServer(options.rpcUrl);
  if (typeof (server as SorobanRpc.Server).getEvents !== "function") {
    throw new Error(
      "streamContractEventsRealTime: the configured RPC server does not support getEvents().",
    );
  }

  const maxAttempts = options.maxAttempts ?? 8;
  const limit = options.limit ?? 100;
  const index = new EventIndex(EVENT_INDEX_DEFAULT_MAX);

  let cursor: string | undefined;
  let consecutiveFailures = 0;

  while (!options.signal?.aborted) {
    try {
      const response = await (server as SorobanRpc.Server).getEvents({
        filters: [{ type: "contract", contractIds: [contractId] }],
        ...(options.startLedger !== undefined && {
          startLedger: options.startLedger,
        }),
        ...(cursor !== undefined && { cursor }),
        limit,
      });

      // A successful poll resets the backoff counter for the next failure.
      consecutiveFailures = 0;

      const events = filterNewEvents(
        index,
        response.events.map((event) => toEvent(event, contractId)),
      );
      if (events.length > 0) {
        yield events;
      }

      if (!response.events || response.events.length === 0) {
        // No new events: re-request from the same cursor. The RPC cursor is
        // only advanced when new events are returned.
        continue;
      }

      cursor = response.cursor;
    } catch (error) {
      consecutiveFailures += 1;
      options.onError?.(error, consecutiveFailures - 1);

      if (consecutiveFailures >= maxAttempts) {
        const terminal = new Error(
          `streamContractEventsRealTime: stopped after ${consecutiveFailures} consecutive RPC failures: ${toMessage(error)}`,
        );
        (terminal as { cause?: unknown }).cause = error;
        throw terminal;
      }

      const delay = computeBackoffDelay(consecutiveFailures - 1, {
        ...(options.backoffInitialMs !== undefined && {
          initialDelayMs: options.backoffInitialMs,
        }),
        ...(options.backoffMaxMs !== undefined && {
          maxDelayMs: options.backoffMaxMs,
        }),
        ...(options.backoffFactor !== undefined && {
          factor: options.backoffFactor,
        }),
        ...(options.jitter !== undefined && { jitter: options.jitter }),
      });
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          options.signal?.removeEventListener("abort", onAbort);
          resolve();
        }, delay);
        const onAbort = (): void => {
          clearTimeout(timer);
          resolve();
        };
        if (options.signal?.aborted) {
          clearTimeout(timer);
          resolve();
          return;
        }
        options.signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }
  // EventIndex is GC'd with the generator scope; nothing retained (#707).
}