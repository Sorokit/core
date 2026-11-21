/**
 * Horizon Server-Sent Events (SSE) real-time streaming (#929)
 *
 * Provides typed real-time SSE streams for Horizon account updates and
 * payment feeds with automatic cursor tracking and exponential-backoff
 * reconnection on disconnect.
 */

import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { validatePublicKey } from "../shared/validation";
import { NETWORK_DEFAULTS } from "./config";

/** Parsed Horizon account update SSE payload. */
export interface HorizonAccountUpdateEvent {
  id: string;
  accountId: string;
  sequence: string;
   pagingToken: string;
  balances: Array<{
    assetType: string;
    assetCode?: string;
    assetIssuer?: string;
    balance: string;
  }>;
  raw: Record<string, unknown>;
}

/** Parsed Horizon payment SSE payload. */
export interface HorizonPaymentStreamEvent {
  id: string;
  pagingToken: string;
  type: string;
  from?: string;
  to?: string;
  amount?: string;
  assetType?: string;
  assetCode?: string;
  assetIssuer?: string;
  transactionHash?: string;
  createdAt?: string;
  raw: Record<string, unknown>;
}

/** Minimal EventSource-compatible interface for browser or custom transports. */
export interface EventSourceLike {
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onopen?: (() => void) | null;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

/** Configuration options for Horizon SSE streams (#929). */
export interface HorizonSSEStreamOptions<TEvent> {
  /** Horizon base URL. Defaults to Testnet Horizon URL. */
  horizonUrl?: string;
  /** Initial cursor (e.g., "now" or a previous paging_token). Default: "now". */
  cursor?: string;
  /** Callback invoked for each parsed SSE event. */
  onEvent: (event: TEvent) => void;
  /** Optional callback invoked when a transport or parse error occurs. */
  onError?: (error: Error) => void;
  /** Optional callback invoked when automatic reconnection is scheduled. */
  onReconnect?: (attempt: number, cursor: string) => void;
  /** Maximum automatic reconnect attempts before stopping. Default: 5. */
  maxReconnectAttempts?: number;
  /** Base reconnect delay in milliseconds. Default: 500. */
  reconnectBaseDelayMs?: number;
  /** Maximum reconnect delay in milliseconds. Default: 15000. */
  reconnectMaxDelayMs?: number;
  /** Optional custom EventSource factory (useful in Node or unit tests). */
  eventSourceFactory?: EventSourceFactory;
  /** Optional custom fetch implementation for fetch-based SSE fallback. */
  fetchFn?: typeof fetch;
}

/** Active Horizon SSE subscription handle. */
export interface HorizonSSESubscription {
  /** Stop the stream and cancel any pending reconnect timers. */
  close(): void;
  /** Whether the subscription is currently active (not closed). */
  isConnected(): boolean;
  /** Most recent paging_token / cursor received from Horizon. */
  getCursor(): string;
  /** Number of automatic reconnections performed so far. */
  getReconnectCount(): number;
  /** Target Horizon SSE endpoint URL. */
  getUrl(): string;
}

function buildHorizonSSEUrl(
  horizonUrl: string,
  path: string,
  cursor: string,
): string {
  const base = horizonUrl.replace(/\/$/, "");
  const url = new URL(`${base}${path}`);
  url.searchParams.set("cursor", cursor);
  return url.toString();
}

function parseAccountUpdateRecord(
  record: Record<string, unknown>,
  fallbackAccountId: string,
  fallbackCursor: string,
): HorizonAccountUpdateEvent {
  const rawBalances = Array.isArray(record.balances) ? record.balances : [];
  const balances = rawBalances
    .filter((b): b is Record<string, unknown> => Boolean(b && typeof b === "object"))
    .map((b) => ({
      assetType: String(b.asset_type ?? "native"),
      ...(typeof b.asset_code === "string" ? { assetCode: b.asset_code } : {}),
      ...(typeof b.asset_issuer === "string" ? { assetIssuer: b.asset_issuer } : {}),
      balance: String(b.balance ?? "0"),
    }));

  const pagingToken =
    typeof record.paging_token === "string" && record.paging_token.length > 0
      ? record.paging_token
      : fallbackCursor;

  return {
    id: String(record.id ?? fallbackAccountId),
    accountId: String(record.account_id ?? record.id ?? fallbackAccountId),
    sequence: String(record.sequence ?? "0"),
    pagingToken,
    balances,
    raw: record,
  };
}

function parsePaymentRecord(
  record: Record<string, unknown>,
  fallbackCursor: string,
): HorizonPaymentStreamEvent {
  const pagingToken =
    typeof record.paging_token === "string" && record.paging_token.length > 0
      ? record.paging_token
      : fallbackCursor;

  return {
    id: String(record.id ?? pagingToken),
    pagingToken,
    type: String(record.type ?? "payment"),
    ...(typeof record.from === "string" ? { from: record.from } : {}),
    ...(typeof record.to === "string" ? { to: record.to } : {}),
    ...(record.amount !== undefined ? { amount: String(record.amount) } : {}),
    ...(typeof record.asset_type === "string" ? { assetType: record.asset_type } : {}),
    ...(typeof record.asset_code === "string" ? { assetCode: record.asset_code } : {}),
    ...(typeof record.asset_issuer === "string" ? { assetIssuer: record.asset_issuer } : {}),
    ...(typeof record.transaction_hash === "string"
      ? { transactionHash: record.transaction_hash }
      : {}),
    ...(typeof record.created_at === "string" ? { createdAt: record.created_at } : {}),
    raw: record,
  };
}

function createFetchEventSource(
  url: string,
  fetchFn: typeof fetch,
): EventSourceLike {
  const controller = new AbortController();
  const source: EventSourceLike = {
    onmessage: null,
    onerror: null,
    onopen: null,
    close() {
      controller.abort();
    },
  };

  void (async () => {
    try {
      const response = await fetchFn(url, {
        headers: { Accept: "text/event-stream" },
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`Horizon SSE request failed with HTTP ${response.status}`);
      }

      source.onopen?.();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (!controller.signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          let lastEventId: string | undefined;
          const dataLines: string[] = [];

          for (const line of frame.split(/\r?\n/)) {
            if (line.startsWith("id:")) {
              lastEventId = line.slice(3).trim();
            } else if (line.startsWith("data:")) {
              dataLines.push(line.slice(5).trim());
            }
          }

          const data = dataLines.join("\n");
          if (!data || data === '"hello"' || data === "byebye") {
            continue;
          }
          source.onmessage?.({
            data,
            ...(lastEventId !== undefined ? { lastEventId } : {}),
          });
        }
      }

      if (!controller.signal.aborted) {
        source.onerror?.(new Error("Horizon SSE stream closed by server"));
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        source.onerror?.(cause);
      }
    }
  })();

  return source;
}

function startManagedSSEStream<TEvent>(
  path: string,
  options: HorizonSSEStreamOptions<TEvent>,
  mapRecord: (record: Record<string, unknown>, cursor: string) => { event: TEvent; cursor: string },
): HorizonSSESubscription {
  const horizonUrl = options.horizonUrl ?? NETWORK_DEFAULTS.testnet.horizonUrl;
  const maxReconnectAttempts = options.maxReconnectAttempts ?? 5;
  const baseDelayMs = options.reconnectBaseDelayMs ?? 500;
  const maxDelayMs = options.reconnectMaxDelayMs ?? 15000;

  let currentCursor = options.cursor ?? "now";
  let reconnectCount = 0;
  let closed = false;
  let connected = false;
  let activeSource: EventSourceLike | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const resolveFactory = (): EventSourceFactory => {
    if (options.eventSourceFactory) {
      return options.eventSourceFactory;
    }
    if (
      !options.fetchFn &&
      typeof globalThis !== "undefined" &&
      "EventSource" in globalThis &&
      typeof (globalThis as unknown as { EventSource?: new (url: string) => EventSourceLike }).EventSource === "function"
    ) {
      const NativeEventSource = (
        globalThis as unknown as { EventSource: new (url: string) => EventSourceLike }
      ).EventSource;
      return (url: string) => new NativeEventSource(url);
    }
    const fetchImpl = options.fetchFn ?? fetch;
    return (url: string) => createFetchEventSource(url, fetchImpl);
  };

  const connect = () => {
    if (closed) return;
    const url = buildHorizonSSEUrl(horizonUrl, path, currentCursor);
    const factory = resolveFactory();
    const source = factory(url);
    activeSource = source;
    connected = true;

    source.onopen = () => {
      connected = true;
    };

    source.onmessage = (msg) => {
      if (closed) return;
      const rawData = msg.data?.trim();
      if (!rawData || rawData === '"hello"' || rawData === "byebye") {
        return;
      }

      try {
        const parsed = JSON.parse(rawData) as Record<string, unknown>;
        const candidateCursor =
          msg.lastEventId ||
          (typeof parsed.paging_token === "string" ? parsed.paging_token : currentCursor);
        const mapped = mapRecord(parsed, candidateCursor);
        currentCursor = mapped.cursor;
        options.onEvent(mapped.event);
      } catch (cause) {
        const parseErr =
          cause instanceof Error
            ? cause
            : new Error(`Invalid Horizon SSE JSON payload: ${String(cause)}`);
        options.onError?.(parseErr);
      }
    };

    source.onerror = (errEvent) => {
      if (closed) return;
      connected = false;
      try {
        source.close();
      } catch {
        // Ignore close errors during reconnect cleanup
      }

      const errorObj =
        errEvent instanceof Error
          ? errEvent
          : new Error("Horizon SSE connection interrupted");
      options.onError?.(errorObj);

      if (reconnectCount >= maxReconnectAttempts) {
        closed = true;
        return;
      }

      reconnectCount += 1;
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (reconnectCount - 1));
      options.onReconnect?.(reconnectCount, currentCursor);

      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };
  };

  connect();

  return {
    close() {
      closed = true;
      connected = false;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (activeSource) {
        try {
          activeSource.close();
        } catch {
          // Ignore close errors
        }
        activeSource = null;
      }
    },
    isConnected() {
      return !closed && connected;
    },
    getCursor() {
      return currentCursor;
    },
    getReconnectCount() {
      return reconnectCount;
    },
    getUrl() {
      return buildHorizonSSEUrl(horizonUrl, path, currentCursor);
    },
  };
}

/**
 * Stream real-time account updates for a Stellar public key via Horizon SSE (#929).
 *
 * Automatically tracks `paging_token` cursors and reconnects with exponential
 * backoff if the SSE stream drops.
 */
export function streamAccountUpdates(
  publicKey: string,
  options: HorizonSSEStreamOptions<HorizonAccountUpdateEvent>,
): SorokitResult<HorizonSSESubscription> {
  const keyValidation = validatePublicKey(publicKey);
  if (keyValidation.status === "error") {
    return keyValidation;
  }

  if (!options || typeof options.onEvent !== "function") {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      "streamAccountUpdates requires an options.onEvent callback function.",
    );
  }

  const subscription = startManagedSSEStream(
    `/accounts/${encodeURIComponent(publicKey)}`,
    options,
    (record, cursor) => {
      const event = parseAccountUpdateRecord(record, publicKey, cursor);
      return { event, cursor: event.pagingToken };
    },
  );

  return ok(subscription);
}

/**
 * Stream real-time payments for a Stellar public key via Horizon SSE (#929).
 *
 * Automatically tracks `paging_token` cursors and reconnects with exponential
 * backoff if the SSE stream drops.
 */
export function streamPayments(
  publicKey: string,
  options: HorizonSSEStreamOptions<HorizonPaymentStreamEvent>,
): SorokitResult<HorizonSSESubscription> {
  const keyValidation = validatePublicKey(publicKey);
  if (keyValidation.status === "error") {
    return keyValidation;
  }

  if (!options || typeof options.onEvent !== "function") {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      "streamPayments requires an options.onEvent callback function.",
    );
  }

  const subscription = startManagedSSEStream(
    `/accounts/${encodeURIComponent(publicKey)}/payments`,
    options,
    (record, cursor) => {
      const event = parsePaymentRecord(record, cursor);
      return { event, cursor: event.pagingToken };
    },
  );

  return ok(subscription);
}
