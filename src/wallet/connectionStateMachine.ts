import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

export type WalletConnectionState = "idle" | "connecting" | "connected" | "error" | "disconnected";
export type WalletConnectionEvent = "connect" | "connected" | "disconnect" | "error" | "reset";

export interface WalletConnectionStateChange {
  from: WalletConnectionState;
  to: WalletConnectionState;
  event: WalletConnectionEvent;
}

export interface WalletConnectionStateMachine {
  readonly state: WalletConnectionState;
  transition(event: WalletConnectionEvent): SorokitResult<WalletConnectionState>;
  onChange(callback: (change: WalletConnectionStateChange) => void): () => void;
}

const TRANSITIONS: Record<WalletConnectionState, Partial<Record<WalletConnectionEvent, WalletConnectionState>>> = {
  idle: { connect: "connecting" },
  connecting: { connected: "connected", error: "error", disconnect: "disconnected" },
  connected: { disconnect: "disconnected", error: "error" },
  error: { connect: "connecting", reset: "idle", disconnect: "disconnected" },
  disconnected: { connect: "connecting", reset: "idle" },
};

export function createConnectionStateMachine(
  initialState: WalletConnectionState = "idle",
): WalletConnectionStateMachine {
  let current = initialState;
  const listeners = new Set<(change: WalletConnectionStateChange) => void>();
  return {
    get state() { return current; },
    transition(event) {
      const next = TRANSITIONS[current][event];
      if (!next) {
        return err(
          SorokitErrorCode.VALIDATION,
          `Invalid wallet connection transition: ${current} -> ${event}`,
        );
      }
      const change = { from: current, to: next, event };
      current = next;
      for (const listener of listeners) {
        try { listener(change); } catch { /* one listener must not block state changes */ }
      }
      return ok(current);
    },
    onChange(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  };
}
