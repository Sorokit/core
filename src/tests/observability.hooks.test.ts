/**
 * Tests for pluggable observability hooks.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  registerObservabilityHook,
  clearObservabilityHooks,
  emitObservabilityEvent,
  type ObservabilityHooks,
} from "../shared/observability";

describe("observability hooks", () => {
  beforeEach(() => {
    clearObservabilityHooks();
  });

  it("registers and invokes hooks for rpc calls", () => {
    const calls: any[] = [];
    const hooks: ObservabilityHooks = {
      onRpcCall: (event) => calls.push(event),
    };
    const unsubscribe = registerObservabilityHook(hooks);
    emitObservabilityEvent({ type: "rpc_call", method: "getAccount", success: true });
    expect(calls.length).toBe(1);
    expect(calls[0].method).toBe("getAccount");
    unsubscribe();
    emitObservabilityEvent({ type: "rpc_call", method: "getAccount", success: true });
    expect(calls.length).toBe(1);
  });

  it("invokes submission hooks", () => {
    const calls: any[] = [];
    registerObservabilityHook({
      onTransactionSubmit: (event) => calls.push(event),
      onSubmission: (event) => calls.push(event),
    });
    emitObservabilityEvent({ type: "transaction_submission", hash: "abc123", status: "confirmed", success: true });
    expect(calls.length).toBe(2);
  });

  it("invokes wallet state change hooks", () => {
    const calls: any[] = [];
    registerObservabilityHook({
      onWalletStateChange: (event) => calls.push(event),
      onWalletEvent: (event) => calls.push(event),
    });
    emitObservabilityEvent({ type: "wallet_state_change", event: "connected", walletType: "FREIGHTER", publicKey: "GABC" });
    expect(calls.length).toBe(2);
  });

  it("invokes cache operation hooks", () => {
    const hits: any[] = [];
    const misses: any[] = [];
    registerObservabilityHook({
      onCacheOperation: () => {},
      onCacheHit: (event) => hits.push(event),
      onCacheMiss: (event) => misses.push(event),
    });
    emitObservabilityEvent({ type: "cache_operation", operation: "hit", key: "k1" });
    emitObservabilityEvent({ type: "cache_operation", operation: "miss", key: "k2" });
    expect(hits.length).toBe(1);
    expect(misses.length).toBe(1);
  });
});
