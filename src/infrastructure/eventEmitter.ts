/**
 * Event Emitter for SDK Operations — Publish Events for Subscribers (#1000)
 *
 * Central event bus for subscribing to SDK operation lifecycle events:
 * - tx_submitted: Transaction sent to network
 * - tx_confirmed: Transaction included in ledger
 * - tx_failed: Transaction rejected or failed
 * - account_fetched: Account metadata retrieved
 * - error: Any SDK error surfaced
 */

export interface TxSubmittedPayload {
  txHash: string;
  sourceAccount?: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface TxConfirmedPayload {
  txHash: string;
  ledger: number;
  timestamp: number;
}

export interface TxFailedPayload {
  txHash?: string;
  error: string;
  code?: string;
  timestamp: number;
}

export interface AccountFetchedPayload {
  accountId: string;
  sequence?: string;
  timestamp: number;
}

export interface SdkErrorPayload {
  code: string;
  message: string;
  details?: unknown;
  timestamp: number;
}

export interface SdkEventMap {
  tx_submitted: TxSubmittedPayload;
  tx_confirmed: TxConfirmedPayload;
  tx_failed: TxFailedPayload;
  account_fetched: AccountFetchedPayload;
  error: SdkErrorPayload;
  [customEvent: string]: any;
}

export type SdkEventListener<T = any> = (payload: T) => void | Promise<void>;

export class SdkOperationEventEmitter {
  private listeners: Map<string, Set<SdkEventListener>> = new Map();

  /**
   * Subscribe to an event. Returns an unsubscribe function.
   */
  on<K extends keyof SdkEventMap>(
    event: K,
    listener: SdkEventListener<SdkEventMap[K]>,
  ): () => void {
    const evt = String(event);
    if (!this.listeners.has(evt)) {
      this.listeners.set(evt, new Set());
    }
    this.listeners.get(evt)!.add(listener);

    return () => {
      this.off(event, listener);
    };
  }

  /**
   * Subscribe to an event for exactly one invocation.
   */
  once<K extends keyof SdkEventMap>(
    event: K,
    listener: SdkEventListener<SdkEventMap[K]>,
  ): () => void {
    const onceWrapper = (payload: SdkEventMap[K]) => {
      this.off(event, onceWrapper);
      listener(payload);
    };
    return this.on(event, onceWrapper);
  }

  /**
   * Unsubscribe a listener from an event.
   */
  off<K extends keyof SdkEventMap>(
    event: K,
    listener: SdkEventListener<SdkEventMap[K]>,
  ): void {
    const evt = String(event);
    const set = this.listeners.get(evt);
    if (set) {
      set.delete(listener);
      if (set.size === 0) {
        this.listeners.delete(evt);
      }
    }
  }

  /**
   * Emit an event with data to all subscribers.
   */
  emit<K extends keyof SdkEventMap>(event: K, payload: SdkEventMap[K]): void {
    const evt = String(event);
    const set = this.listeners.get(evt);
    if (!set || set.size === 0) return;

    // Snapshot to avoid mutation during dispatch
    const callbacks = Array.from(set);
    for (const cb of callbacks) {
      try {
        const res = cb(payload);
        if (res instanceof Promise) {
          res.catch(() => {});
        }
      } catch {
        // Listener error is caught to prevent breaking other listeners
      }
    }
  }

  /**
   * Number of active listeners for an event.
   */
  listenerCount(event: string | keyof SdkEventMap): number {
    return this.listeners.get(String(event))?.size ?? 0;
  }

  /**
   * Remove all listeners for an event or all events.
   */
  removeAllListeners(event?: string | keyof SdkEventMap): void {
    if (event) {
      this.listeners.delete(String(event));
    } else {
      this.listeners.clear();
    }
  }
}

export function createSdkEventEmitter(): SdkOperationEventEmitter {
  return new SdkOperationEventEmitter();
}

/** Global default SDK operation event bus */
export const sdkEventEmitter = new SdkOperationEventEmitter();
