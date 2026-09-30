/**
 * Real-time transaction status dashboard (#708).
 *
 * Problem: `getTransactionStatus` only gives point-in-time checks and
 * `streamTransactions` yields raw pages — neither provides the aggregated
 * statistics (success rates, processing times, fee analysis), live-update
 * fan-out, or chart-ready shapes that frontends need for dashboards.
 *
 * This module provides:
 * - {@link TransactionStatusAggregator}: bounded in-memory store that ingests
 *   `TransactionResult`s and serves pre-calculated metrics + chart data.
 * - Categorization + filtering helpers for organizing transactions.
 * - Live-update streaming: attach any async transaction source, or a
 *   WebSocket feed, and all dashboard subscribers are notified in real time.
 * - Dashboard-ready data structures (`DashboardSnapshot`, `DashboardMetrics`,
 *   `DashboardChartData`) plus React/Vue usage examples.
 *
 * Memory: the aggregator is bounded (`maxEntries` + `ttlMs`) and prunes
 * automatically, so dashboards left open for hours don't leak (#707).
 */

import type { TransactionResult, TransactionStatus } from "./types";

// ─── Types ────────────────────────────────────────────────────────────────────

/** High-level bucket used to organize transactions on a dashboard. */
export type TransactionCategory =
  | "payment"
  | "dex"
  | "soroban"
  | "account"
  | "asset"
  | "other";

/** Named time windows for dashboard queries. */
export type DashboardTimeRange = "1h" | "24h" | "7d" | "30d" | "all";

export interface DashboardTimeWindow {
  from?: number;
  to?: number;
}

/** Extra dashboard metadata attached at ingest time. */
export interface DashboardEntryHints {
  /** Explicit category; when omitted it is inferred from `operationType`. */
  category?: TransactionCategory | string;
  /** Operation type, e.g. "payment", "manageOffer", "invokeHostFunction". */
  operationType?: string;
  /** Epoch ms when the transaction was submitted (for processing-time stats). */
  submittedAt?: number;
}

/** A single dashboard-tracked transaction. */
export interface DashboardTransactionEntry {
  tx: TransactionResult;
  category: string;
  operationType?: string;
  /** Epoch ms derived from `tx.createdAt` (NaN-safe, may be undefined). */
  createdAtMs?: number;
  /** Confirmation latency in ms (createdAt - submittedAt), when known. */
  processingTimeMs?: number;
  /** Fee in stroops as a number (NaN-safe, may be undefined). */
  feeNumber?: number;
  ingestedAt: number;
}

export interface DashboardFilter {
  statuses?: TransactionStatus[];
  categories?: string[];
  operationTypes?: string[];
  /** Named range shortcut; explicit from/to take precedence when both set. */
  range?: DashboardTimeRange;
  from?: number | string | Date;
  to?: number | string | Date;
  minFee?: number;
  maxFee?: number;
  /** Case-insensitive substring match against hash / operationType / category. */
  search?: string;
}

export interface DashboardMetrics {
  total: number;
  success: number;
  failed: number;
  pending: number;
  notFound: number;
  /** 0..1 (0 when total is 0). */
  successRate: number;
  /** Fee stats in stroops (null when no numeric fees in scope). */
  avgFee: string | null;
  medianFee: string | null;
  totalFees: string | null;
  minFee: string | null;
  maxFee: string | null;
  /** Confirmation-latency stats in ms (null when unknown). */
  avgProcessingTimeMs: number | null;
  p95ProcessingTimeMs: number | null;
  byCategory: Record<string, number>;
  byStatus: Record<string, number>;
}

export interface DashboardChartPoint {
  timestamp: number;
  count: number;
}

export interface DashboardFeePoint {
  timestamp: number;
  avgFee: number;
}

export interface DashboardChartData {
  /** Pie/donut-ready status distribution. */
  statusDistribution: Array<{ label: string; value: number }>;
  /** Bar/donut-ready category breakdown. */
  categoryBreakdown: Array<{ label: string; value: number }>;
  /** Line/area-ready throughput buckets. */
  throughput: DashboardChartPoint[];
  /** Line-ready average-fee buckets. */
  feeTrend: DashboardFeePoint[];
}

export interface DashboardSnapshot {
  metrics: DashboardMetrics;
  charts: DashboardChartData;
  /** Most recent entries (newest first), capped by `recentLimit`. */
  recent: DashboardTransactionEntry[];
  generatedAt: number;
}

export type DashboardListener = (snapshot: DashboardSnapshot) => void;

export interface TransactionStatusAggregatorOptions {
  /** Max entries retained; oldest evicted first. Default: 2000. */
  maxEntries?: number;
  /** Max age (ms) before an entry is evicted on prune. Omit for no TTL. */
  ttlMs?: number;
  /** Recent list size in snapshots. Default: 25. */
  recentLimit?: number;
  /** Throughput bucket size in ms. Default: 60_000 (1 minute). */
  bucketMs?: number;
  /** Clock override (tests). */
  now?: () => number;
}

// ─── Categorization ───────────────────────────────────────────────────────────

/** Map a raw operation type to a dashboard category. */
export function categoryFromOperationType(operationType?: string): string {
  if (!operationType) return "other";
  const normalized = operationType.toLowerCase().replace(/[^a-z]/g, "");
  if (/(payment|pathpayment|claimable|trustline|merge|bumpsequence|setoptions|account)/.test(normalized)) {
    if (/(manageoffer|createpassive|trade|liquidity|swap|pathpayment)/.test(normalized)) return "dex";
    if (/(trustline|asset|clawback|allow)/.test(normalized)) return "asset";
    if (/(createaccount|setoptions|bumpsequence|merge|data|signer|sponsor)/.test(normalized)) return "account";
    return "payment";
  }
  if (/(invoke|contract|soroban|extendfootprint|restore)/.test(normalized)) return "soroban";
  if (/(offer|trade|liquidity|pool|swap)/.test(normalized)) return "dex";
  if (/(asset|trustline|clawback)/.test(normalized)) return "asset";
  if (/(account|signer|data|sponsor|merge)/.test(normalized)) return "account";
  return "other";
}

/**
 * Categorize a transaction for dashboard grouping.
 * Explicit hints win; otherwise the category is inferred from `operationType`.
 */
export function categorizeTransaction(
  tx: TransactionResult,
  hints?: DashboardEntryHints,
): { category: string; operationType?: string } {
  const operationType = hints?.operationType;
  const category = hints?.category ?? categoryFromOperationType(operationType);
  void tx;
  return operationType === undefined ? { category } : { category, operationType };
}

/** Filter entries by dashboard criteria (pure, returns a new array). */
export function filterDashboardTransactions(
  entries: readonly DashboardTransactionEntry[],
  filter?: DashboardFilter,
  now: number = Date.now(),
): DashboardTransactionEntry[] {
  if (!filter) return [...entries];
  const statuses = filter.statuses && filter.statuses.length > 0 ? new Set(filter.statuses) : undefined;
  const categories = filter.categories && filter.categories.length > 0
    ? new Set(filter.categories.map((c) => c.toLowerCase()))
    : undefined;
  const opTypes = filter.operationTypes && filter.operationTypes.length > 0
    ? new Set(filter.operationTypes.map((o) => o.toLowerCase()))
    : undefined;
  const window = resolveTimeWindow(filter, now);
  const search = filter.search?.toLowerCase();

  return entries.filter((entry) => {
    if (statuses && !statuses.has(entry.tx.status)) return false;
    if (categories && !categories.has(entry.category.toLowerCase())) return false;
    if (opTypes && !(entry.operationType && opTypes.has(entry.operationType.toLowerCase()))) return false;
    if (window.from !== undefined && (entry.createdAtMs ?? entry.ingestedAt) < window.from) return false;
    if (window.to !== undefined && (entry.createdAtMs ?? entry.ingestedAt) > window.to) return false;
    if (filter.minFee !== undefined && (entry.feeNumber ?? Infinity) < filter.minFee) return false;
    if (filter.maxFee !== undefined && (entry.feeNumber ?? -Infinity) > filter.maxFee) return false;
    if (search) {
      const haystack = `${entry.tx.hash} ${entry.operationType ?? ""} ${entry.category}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}

// ─── Aggregator ───────────────────────────────────────────────────────────────

/**
 * Bounded, real-time aggregator of transaction statuses.
 *
 * Ingest transactions (manually, from `streamTransactions`, or from a
 * WebSocket feed), subscribe UI listeners, and pull dashboard-ready snapshots
 * with pre-calculated metrics and chart data.
 *
 * @example
 * const dashboard = new TransactionStatusAggregator({ maxEntries: 1000 });
 * dashboard.record(tx, { operationType: "payment" });
 * const snapshot = dashboard.getSnapshot();
 * console.log(snapshot.metrics.successRate);
 */
export class TransactionStatusAggregator {
  private entries = new Map<string, DashboardTransactionEntry>();
  private listeners = new Set<DashboardListener>();
  private readonly maxEntries: number;
  private readonly ttlMs?: number;
  private readonly recentLimit: number;
  private readonly bucketMs: number;
  private readonly now: () => number;

  constructor(options?: TransactionStatusAggregatorOptions) {
    this.maxEntries = Math.max(1, Math.floor(options?.maxEntries ?? 2000));
    this.ttlMs = options?.ttlMs;
    this.recentLimit = Math.max(1, Math.floor(options?.recentLimit ?? 25));
    this.bucketMs = Math.max(1000, Math.floor(options?.bucketMs ?? 60_000));
    this.now = options?.now ?? Date.now;
  }

  /** Ingest (or update) a single transaction; notifies subscribers. */
  record(tx: TransactionResult, hints?: DashboardEntryHints): DashboardTransactionEntry {
    const { category, operationType } = categorizeTransaction(tx, hints);
    const createdAtMs = parseCreatedAt(tx.createdAt);
    const submittedAt = hints?.submittedAt;
    const entry: DashboardTransactionEntry = {
      tx,
      category,
      ...(operationType !== undefined ? { operationType } : {}),
      ...(createdAtMs !== undefined ? { createdAtMs } : {}),
      ...(createdAtMs !== undefined && submittedAt !== undefined && createdAtMs >= submittedAt
        ? { processingTimeMs: createdAtMs - submittedAt }
        : {}),
      ...(toFeeNumber(tx.fee) !== undefined ? { feeNumber: toFeeNumber(tx.fee) } : {}),
      ingestedAt: this.now(),
    };
    // Re-insert to keep newest-last ordering for eviction.
    this.entries.delete(tx.hash);
    this.entries.set(tx.hash, entry);
    this.prune();
    this.emit();
    return entry;
  }

  /** Ingest a batch; emits a single notification. */
  recordBatch(txs: readonly TransactionResult[], hints?: DashboardEntryHints): number {
    for (const tx of txs) {
      const { category, operationType } = categorizeTransaction(tx, hints);
      const createdAtMs = parseCreatedAt(tx.createdAt);
      const entry: DashboardTransactionEntry = {
        tx,
        category,
        ...(operationType !== undefined ? { operationType } : {}),
        ...(createdAtMs !== undefined ? { createdAtMs } : {}),
        ...(toFeeNumber(tx.fee) !== undefined ? { feeNumber: toFeeNumber(tx.fee) } : {}),
        ingestedAt: this.now(),
      };
      this.entries.delete(tx.hash);
      this.entries.set(tx.hash, entry);
    }
    this.prune();
    this.emit();
    return txs.length;
  }

  /** Subscribe to snapshot updates. Returns an unsubscribe function. */
  subscribe(listener: DashboardListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Number of active dashboard listeners (leak visibility for SPAs). */
  listenerCount(): number {
    return this.listeners.size;
  }

  /** Remove all listeners (e.g. on unmount / HMR). */
  removeAllListeners(): void {
    this.listeners.clear();
  }

  /** Entries in scope for a filter (newest first). */
  query(filter?: DashboardFilter): DashboardTransactionEntry[] {
    const scoped = filterDashboardTransactions([...this.entries.values()], filter, this.now());
    return scoped.sort((a, b) => (b.createdAtMs ?? b.ingestedAt) - (a.createdAtMs ?? a.ingestedAt));
  }

  /** Pre-calculated metrics for a filter scope. */
  getMetrics(filter?: DashboardFilter): DashboardMetrics {
    return computeMetrics(this.query(filter));
  }

  /** Chart-ready aggregates for a filter scope. */
  getChartData(filter?: DashboardFilter): DashboardChartData {
    return computeChartData(this.query(filter), this.bucketMs);
  }

  /** Full dashboard snapshot: metrics + charts + recent entries. */
  getSnapshot(filter?: DashboardFilter): DashboardSnapshot {
    const scoped = this.query(filter);
    return {
      metrics: computeMetrics(scoped),
      charts: computeChartData(scoped, this.bucketMs),
      recent: scoped.slice(0, this.recentLimit),
      generatedAt: this.now(),
    };
  }

  /**
   * Trend comparison: metrics for `range` vs the immediately preceding window
   * of equal length. Useful for "success rate ▲ 2.1%" deltas.
   */
  getTrends(range: DashboardTimeRange = "24h", filter?: Omit<DashboardFilter, "range" | "from" | "to">): {
    current: DashboardMetrics;
    previous: DashboardMetrics;
    successRateDelta: number;
    throughputDelta: number;
  } {
    const spanMs = rangeSpanMs(range);
    const end = this.now();
    const currentFilter: DashboardFilter = { ...filter, from: end - spanMs, to: end };
    const previousFilter: DashboardFilter = { ...filter, from: end - 2 * spanMs, to: end - spanMs };
    const current = computeMetrics(filterDashboardTransactions([...this.entries.values()], currentFilter, end));
    const previous = computeMetrics(filterDashboardTransactions([...this.entries.values()], previousFilter, end));
    return {
      current,
      previous,
      successRateDelta: current.successRate - previous.successRate,
      throughputDelta: current.total - previous.total,
    };
  }

  /** Number of retained entries. */
  size(): number {
    return this.entries.size;
  }

  /** Drop entries for one transaction hash. Returns true when removed. */
  remove(hash: string): boolean {
    return this.entries.delete(hash);
  }

  /** Drop all entries and emit an empty snapshot. */
  clear(): void {
    this.entries.clear();
    this.emit();
  }

  /** Evict entries exceeding TTL / capacity. Returns evicted count. */
  prune(now: number = this.now()): number {
    let evicted = 0;
    if (this.ttlMs !== undefined) {
      for (const [hash, entry] of this.entries) {
        if (now - entry.ingestedAt > this.ttlMs) {
          this.entries.delete(hash);
          evicted++;
        }
      }
    }
    if (this.entries.size > this.maxEntries) {
      const excess = this.entries.size - this.maxEntries;
      const keys = this.entries.keys();
      for (let i = 0; i < excess; i++) {
        const oldest = keys.next().value as string | undefined;
        if (!oldest) break;
        this.entries.delete(oldest);
        evicted++;
      }
    }
    return evicted;
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.getSnapshot();
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch {
        // Listener errors must not break the aggregator or other listeners.
      }
    }
  }
}

/** Create an aggregator (factory alias for DI / framework wrappers). */
export function createTransactionStatusAggregator(
  options?: TransactionStatusAggregatorOptions,
): TransactionStatusAggregator {
  return new TransactionStatusAggregator(options);
}

// ─── Live streaming ───────────────────────────────────────────────────────────

export interface TransactionStatusStreamOptions {
  /** Poll interval when the source is a pull function. Default: 5000. */
  intervalMs?: number;
  /** Forward hints applied to every ingested transaction. */
  hints?: DashboardEntryHints;
  /** Stop after this many polls (omit for infinite). */
  maxPolls?: number;
  /** AbortSignal to stop the stream externally. */
  signal?: AbortSignal;
  /** Per-cycle error hook (errors are swallowed to keep the stream alive). */
  onError?: (error: unknown) => void;
}

export interface TransactionStatusStreamHandle {
  /** Stop the stream and release timers/listeners. */
  stop: () => void;
  /** True while the poll loop is active. */
  readonly active: boolean;
}

/**
 * Attach a pull-based transaction source to a dashboard for live updates.
 * The source is polled and every transaction is recorded in the aggregator
 * (which fans out to all dashboard subscribers).
 */
export function streamTransactionStatus(
  source: () => Promise<readonly TransactionResult[]>,
  aggregator: TransactionStatusAggregator,
  options?: TransactionStatusStreamOptions,
): TransactionStatusStreamHandle {
  const intervalMs = Math.max(1000, options?.intervalMs ?? 5000);
  const maxPolls = options?.maxPolls;
  const signal = options?.signal;
  let polls = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onAbort = (): void => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  const poll = async (): Promise<void> => {
    if (stopped || signal?.aborted) return;
    if (maxPolls !== undefined && polls >= maxPolls) {
      handle.stop();
      return;
    }
    try {
      const txs = await source();
      if (txs.length > 0) aggregator.recordBatch(txs, options?.hints);
    } catch (error) {
      options?.onError?.(error);
    }
    polls++;
    if (!stopped && !signal?.aborted && (maxPolls === undefined || polls < maxPolls)) {
      timer = setTimeout(() => {
        void poll();
      }, intervalMs);
    }
  };

  void poll();

  const handle: TransactionStatusStreamHandle = {
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      signal?.removeEventListener("abort", onAbort);
    },
    get active() {
      return !stopped && !signal?.aborted;
    },
  };
  return handle;
}

/**
 * Consume any `AsyncIterable` of transaction pages/results (e.g. wrapping
 * `streamTransactions`) into the dashboard until aborted.
 */
export async function attachTransactionStreamToDashboard(
  pages: AsyncIterable<{ transactions: TransactionResult[] } | TransactionResult[]>,
  aggregator: TransactionStatusAggregator,
  options?: { hints?: DashboardEntryHints; signal?: AbortSignal; onError?: (error: unknown) => void },
): Promise<void> {
  for await (const page of pages) {
    if (options?.signal?.aborted) return;
    try {
      const txs = Array.isArray(page) ? page : page.transactions;
      if (txs.length > 0) aggregator.recordBatch(txs, options?.hints);
    } catch (error) {
      options?.onError?.(error);
    }
  }
}

// ─── WebSocket live feed ──────────────────────────────────────────────────────

export interface WebSocketTransactionFeedOptions {
  /** Reconnect attempts before giving up. Default: 5. */
  maxReconnectAttempts?: number;
  /** Base reconnect delay (ms, exponential backoff). Default: 1000. */
  reconnectDelayMs?: number;
  /** Forward hints applied to every ingested transaction. */
  hints?: DashboardEntryHints;
  /** Injectable WebSocket constructor (defaults to globalThis.WebSocket). */
  webSocketImpl?: new (url: string) => WebSocketLike;
  /** Lifecycle hooks. */
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (error: unknown) => void;
}

/** Minimal WebSocket surface used by the feed (browser + `ws` compatible). */
export interface WebSocketLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  close(): void;
}

export interface WebSocketTransactionFeedHandle {
  close: () => void;
  /** True while the socket is open or reconnecting. */
  readonly active: boolean;
  /** Current reconnect attempt count. */
  readonly reconnectAttempts: number;
}

/**
 * Stream live transaction updates over WebSocket into the dashboard.
 * Incoming messages may be a single `TransactionResult` or an array of them
 * (JSON). The feed auto-reconnects with exponential backoff and cleans up
 * all listeners on `close()` (no leaks on SPA navigation, #707).
 */
export function createWebSocketTransactionFeed(
  url: string,
  aggregator: TransactionStatusAggregator,
  options?: WebSocketTransactionFeedOptions,
): WebSocketTransactionFeedHandle {
  const maxReconnects = options?.maxReconnectAttempts ?? 5;
  const baseDelay = options?.reconnectDelayMs ?? 1000;
  const Impl = options?.webSocketImpl ??
    (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (!Impl) {
    throw new Error("createWebSocketTransactionFeed: no WebSocket implementation available.");
  }

  let socket: WebSocketLike | null = null;
  let closed = false;
  let reconnects = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const ingest = (data: unknown): void => {
    try {
      const parsed = typeof data === "string" ? JSON.parse(data) : data;
      const txs = normalizeFeedPayload(parsed);
      if (txs.length > 0) aggregator.recordBatch(txs, options?.hints);
    } catch (error) {
      options?.onError?.(error);
    }
  };

  const connect = (): void => {
    if (closed) return;
    const ws = new Impl(url);
    socket = ws;
    ws.onopen = () => {
      reconnects = 0;
      options?.onOpen?.();
    };
    ws.onmessage = (event) => ingest(event.data);
    ws.onerror = (event) => options?.onError?.(event);
    ws.onclose = () => {
      socket = null;
      options?.onClose?.();
      if (closed || reconnects >= maxReconnects) return;
      reconnects++;
      timer = setTimeout(connect, baseDelay * 2 ** (reconnects - 1));
    };
  };

  connect();

  return {
    close: () => {
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (socket) {
        const ws = socket;
        socket = null;
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        try {
          ws.close();
        } catch {
          // Ignore close errors; listeners are already detached.
        }
      }
    },
    get active() {
      return !closed;
    },
    get reconnectAttempts() {
      return reconnects;
    },
  };
}

function normalizeFeedPayload(payload: unknown): TransactionResult[] {
  const candidates = Array.isArray(payload) ? payload : [payload];
  const out: TransactionResult[] = [];
  for (const item of candidates) {
    if (isTransactionResult(item)) out.push(item);
    else if (item && typeof item === "object" && Array.isArray((item as { transactions?: unknown }).transactions)) {
      for (const tx of (item as { transactions: unknown[] }).transactions) {
        if (isTransactionResult(tx)) out.push(tx);
      }
    }
  }
  return out;
}

function isTransactionResult(value: unknown): value is TransactionResult {
  if (!value || typeof value !== "object") return false;
  const tx = value as Partial<TransactionResult>;
  return typeof tx.hash === "string" && typeof tx.status === "string";
}

// ─── Internals ────────────────────────────────────────────────────────────────

function parseCreatedAt(createdAt?: string): number | undefined {
  if (!createdAt) return undefined;
  const ms = Date.parse(createdAt);
  return Number.isFinite(ms) ? ms : undefined;
}

function toFeeNumber(fee?: string): number | undefined {
  if (fee === undefined) return undefined;
  const n = Number(fee);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function toTimestamp(value: number | string | Date | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function rangeSpanMs(range: DashboardTimeRange): number {
  switch (range) {
    case "1h": return 60 * 60 * 1000;
    case "24h": return 24 * 60 * 60 * 1000;
    case "7d": return 7 * 24 * 60 * 60 * 1000;
    case "30d": return 30 * 24 * 60 * 60 * 1000;
    case "all": return 3650 * 24 * 60 * 60 * 1000;
  }
}

function resolveTimeWindow(filter: DashboardFilter, now: number): DashboardTimeWindow {
  const from = toTimestamp(filter.from);
  const to = toTimestamp(filter.to);
  if (from !== undefined || to !== undefined) return { ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) };
  if (!filter.range || filter.range === "all") return {};
  const span = rangeSpanMs(filter.range);
  return { from: now - span, to: now };
}

function computeMetrics(entries: readonly DashboardTransactionEntry[]): DashboardMetrics {
  const byStatus: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  let success = 0;
  let failed = 0;
  let pending = 0;
  let notFound = 0;
  const fees: number[] = [];
  let feeTotal = 0;
  const processingTimes: number[] = [];

  for (const entry of entries) {
    byStatus[entry.tx.status] = (byStatus[entry.tx.status] ?? 0) + 1;
    byCategory[entry.category] = (byCategory[entry.category] ?? 0) + 1;
    switch (entry.tx.status) {
      case "success": success++; break;
      case "failed": failed++; break;
      case "pending": pending++; break;
      default: notFound++; break;
    }
    if (entry.feeNumber !== undefined) {
      fees.push(entry.feeNumber);
      feeTotal += entry.feeNumber;
    }
    if (entry.processingTimeMs !== undefined) processingTimes.push(entry.processingTimeMs);
  }

  fees.sort((a, b) => a - b);
  processingTimes.sort((a, b) => a - b);
  const total = entries.length;
  const confirmed = success + failed;

  return {
    total,
    success,
    failed,
    pending,
    notFound,
    successRate: confirmed === 0 ? 0 : success / confirmed,
    avgFee: fees.length > 0 ? Math.floor(feeTotal / fees.length).toString() : null,
    medianFee: fees.length > 0 ? Math.floor(quantile(fees, 0.5)).toString() : null,
    totalFees: fees.length > 0 ? Math.floor(feeTotal).toString() : null,
    minFee: fees.length > 0 ? Math.floor(fees[0] as number).toString() : null,
    maxFee: fees.length > 0 ? Math.floor(fees[fees.length - 1] as number).toString() : null,
    avgProcessingTimeMs: processingTimes.length > 0
      ? processingTimes.reduce((a, b) => a + b, 0) / processingTimes.length
      : null,
    p95ProcessingTimeMs: processingTimes.length > 0 ? quantile(processingTimes, 0.95) : null,
    byCategory,
    byStatus,
  };
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx] as number;
}

function computeChartData(
  entries: readonly DashboardTransactionEntry[],
  bucketMs: number,
): DashboardChartData {
  const statusCounts = new Map<string, number>();
  const categoryCounts = new Map<string, number>();
  const throughput = new Map<number, number>();
  const feeBuckets = new Map<number, { total: number; count: number }>();

  for (const entry of entries) {
    statusCounts.set(entry.tx.status, (statusCounts.get(entry.tx.status) ?? 0) + 1);
    categoryCounts.set(entry.category, (categoryCounts.get(entry.category) ?? 0) + 1);
    const ts = entry.createdAtMs ?? entry.ingestedAt;
    const bucket = Math.floor(ts / bucketMs) * bucketMs;
    throughput.set(bucket, (throughput.get(bucket) ?? 0) + 1);
    if (entry.feeNumber !== undefined) {
      const bucketFee = feeBuckets.get(bucket) ?? { total: 0, count: 0 };
      bucketFee.total += entry.feeNumber;
      bucketFee.count += 1;
      feeBuckets.set(bucket, bucketFee);
    }
  }

  const throughputPoints = [...throughput.entries()]
    .map(([timestamp, count]) => ({ timestamp, count }))
    .sort((a, b) => a.timestamp - b.timestamp);
  const feeTrend = [...feeBuckets.entries()]
    .map(([timestamp, { total, count }]) => ({ timestamp, avgFee: total / count }))
    .sort((a, b) => a.timestamp - b.timestamp);

  return {
    statusDistribution: [...statusCounts.entries()].map(([label, value]) => ({ label, value })),
    categoryBreakdown: [...categoryCounts.entries()].map(([label, value]) => ({ label, value })),
    throughput: throughputPoints,
    feeTrend,
  };
}

// ─── Framework examples ───────────────────────────────────────────────────────
// Copy-paste starters for common dashboard patterns. Kept as string constants
// (instead of .tsx imports) so this package stays framework-agnostic.

/** React dashboard component example (uses `TransactionStatusAggregator`). */
export const REACT_DASHBOARD_EXAMPLE = `import { useEffect, useMemo, useState } from "react";
import {
  TransactionStatusAggregator,
  type DashboardSnapshot,
} from "sorokit-core/transaction";

export function TransactionStatusDashboard({ aggregator }: { aggregator: TransactionStatusAggregator }) {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>(() => aggregator.getSnapshot());

  useEffect(() => aggregator.subscribe(setSnapshot), [aggregator]);

  const rate = useMemo(
    () => (snapshot.metrics.successRate * 100).toFixed(1) + "%",
    [snapshot],
  );

  return (
    <section aria-label="Transaction status dashboard">
      <header>
        <h2>Transactions ({snapshot.metrics.total})</h2>
        <p>Success rate: {rate} · Avg fee: {snapshot.metrics.avgFee ?? "—"}</p>
      </header>
      <ul>
        {snapshot.charts.statusDistribution.map((s) => (
          <li key={s.label}>{s.label}: {s.value}</li>
        ))}
      </ul>
      <ol>
        {snapshot.recent.map((entry) => (
          <li key={entry.tx.hash}>
            {entry.tx.hash.slice(0, 8)}… — {entry.tx.status} ({entry.category})
          </li>
        ))}
      </ol>
    </section>
  );
}

// Live wiring:
// const dashboard = new TransactionStatusAggregator({ maxEntries: 1000 });
// streamTransactionStatus(async () => fetchRecentTransactions(), dashboard, { intervalMs: 5000 });
// <TransactionStatusDashboard aggregator={dashboard} />
`;

/** Vue dashboard component example (uses `TransactionStatusAggregator`). */
export const VUE_DASHBOARD_EXAMPLE = `<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import {
  TransactionStatusAggregator,
  type DashboardSnapshot,
} from "sorokit-core/transaction";

const props = defineProps<{ aggregator: TransactionStatusAggregator }>();
const snapshot = ref<DashboardSnapshot>(props.aggregator.getSnapshot());
let unsubscribe: (() => void) | undefined;

onMounted(() => {
  unsubscribe = props.aggregator.subscribe((next) => {
    snapshot.value = next;
  });
});

onUnmounted(() => {
  unsubscribe?.();
});
</script>

<template>
  <section aria-label="Transaction status dashboard">
    <header>
      <h2>Transactions ({{ snapshot.metrics.total }})</h2>
      <p>
        Success rate: {{ (snapshot.metrics.successRate * 100).toFixed(1) }}% ·
        Avg fee: {{ snapshot.metrics.avgFee ?? "—" }}
      </p>
    </header>
    <ul>
      <li v-for="s in snapshot.charts.statusDistribution" :key="s.label">
        {{ s.label }}: {{ s.value }}
      </li>
    </ul>
    <ol>
      <li v-for="entry in snapshot.recent" :key="entry.tx.hash">
        {{ entry.tx.hash.slice(0, 8) }}… — {{ entry.tx.status }} ({{ entry.category }})
      </li>
    </ol>
  </section>
</template>
`;
