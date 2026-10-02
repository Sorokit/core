/**
 * Wallet Event Emitter and Status Change Notifications (#613)
 *
 * A small, named multi-event emitter for wallet lifecycle events:
 * - "connected": a wallet finished connecting successfully
 * - "disconnected": a wallet finished disconnecting
 * - "accountChanged": the active account switched (bridged from
 *   {@link WalletAccountManager.watchAccountSwitch})
 * - "networkChanged": a connected wallet reported switching networks
 *
 * This is deliberately separate from {@link WalletStatusTracker}, which emits
 * a single full-status snapshot to one listener type. WalletEventEmitter
 * instead gives callers a Node-`EventEmitter`-style `on`/`off` API scoped to
 * named events, each with its own payload shape.
 *
 * `networkChanged` has no trigger today: a SorokitClient resolves its network
 * once at creation (see `resolveNetwork` in createSorokitClient.ts) rather
 * than tracking a value that changes during a session, and no bundled
 * WalletAdapter currently detects or reports the connected wallet switching
 * networks. The event and its emit path exist so a custom adapter (or a
 * future built-in one) can report this via {@link WalletEventEmitter.emit};
 * until one does, `networkChanged` simply never fires.
 */

import type { WalletState, WalletType } from "./types";
import type { AccountData } from "./accountManager";

export interface WalletConnectedEvent {
  walletType: WalletType;
  publicKey: string;
}

export interface WalletDisconnectedEvent {
  walletType: WalletType;
}

export interface WalletAccountChangedEvent {
  activeAccount: AccountData | null;
  previousAccount: AccountData | null;
}

export interface WalletNetworkChangedEvent {
  walletType: WalletType;
  previousNetwork: string;
  network: string;
}

/** Map of every named wallet event to its payload type. */
export interface WalletEventMap {
  connected: WalletConnectedEvent;
  disconnected: WalletDisconnectedEvent;
  accountChanged: WalletAccountChangedEvent;
  networkChanged: WalletNetworkChangedEvent;
}

export type WalletEventName = keyof WalletEventMap;

export type WalletEventListener<E extends WalletEventName> = (
  payload: WalletEventMap[E],
) => void;

/** Function returned by {@link WalletEventEmitter.on} to remove that listener. */
export type WalletEventUnsubscribe = () => void;

/**
 * Named multi-event emitter for wallet lifecycle notifications.
 *
 * @example
 * const unsubscribe = client.wallet.events.on("accountChanged", ({ activeAccount }) => {
 *   console.log("active account is now", activeAccount?.publicKey);
 * });
 * // later
 * unsubscribe();
 */
export class WalletEventEmitter {
  private listeners: { [K in WalletEventName]: Set<WalletEventListener<K>> } = {
    connected: new Set(),
    disconnected: new Set(),
    accountChanged: new Set(),
    networkChanged: new Set(),
  };

  /** Subscribe to a named wallet event. Returns an unsubscribe callback. */
  on<E extends WalletEventName>(
    event: E,
    listener: WalletEventListener<E>,
  ): WalletEventUnsubscribe {
    this.listeners[event].add(listener);
    return () => {
      this.listeners[event].delete(listener);
    };
  }

  /** Remove a previously registered listener for a named wallet event. */
  off<E extends WalletEventName>(event: E, listener: WalletEventListener<E>): void {
    this.listeners[event].delete(listener);
  }

  /** Remove every listener, optionally scoped to a single event. */
  removeAllListeners(event?: WalletEventName): void {
    if (event) {
      this.listeners[event].clear();
      return;
    }
    for (const set of Object.values(this.listeners)) set.clear();
  }

  /**
   * Emit a named wallet event to every current subscriber.
   *
   * A throwing listener is caught and ignored so one bad handler cannot
   * break emission to the rest, matching WalletAccountManager's
   * notifySwitch behavior.
   */
  emit<E extends WalletEventName>(event: E, payload: WalletEventMap[E]): void {
    for (const listener of this.listeners[event]) {
      try {
        listener(payload);
      } catch {
        // Prevent listener errors from breaking execution
      }
    }
  }
}

/** Create a standalone WalletEventEmitter instance. */
export function createWalletEventEmitter(): WalletEventEmitter {
  return new WalletEventEmitter();
}

/** Derive the WalletConnectedEvent payload from a successful connect's WalletState. */
export function toConnectedEvent(state: WalletState): WalletConnectedEvent | null {
  if (!state.connected || state.publicKey === null || state.walletType === null) {
    return null;
  }
  return { walletType: state.walletType, publicKey: state.publicKey };
}
