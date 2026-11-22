import { describe, it, expect, vi } from "vitest";
import {
  createSdkEventEmitter,
  type TxSubmittedPayload,
  type TxConfirmedPayload,
  type SdkErrorPayload,
} from "./eventEmitter";

describe("SDK Operation Event Emitter (#1000)", () => {
  it("subscribes and receives emitted events", () => {
    const emitter = createSdkEventEmitter();
    const listener = vi.fn();

    const unsub = emitter.on("tx_submitted", listener);
    expect(emitter.listenerCount("tx_submitted")).toBe(1);

    const payload: TxSubmittedPayload = {
      txHash: "0xabc123",
      sourceAccount: "GABC...",
      timestamp: Date.now(),
    };

    emitter.emit("tx_submitted", payload);
    expect(listener).toHaveBeenCalledWith(payload);

    unsub();
    expect(emitter.listenerCount("tx_submitted")).toBe(0);
    emitter.emit("tx_submitted", payload);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("supports once subscriptions", () => {
    const emitter = createSdkEventEmitter();
    const listener = vi.fn();

    emitter.once("tx_confirmed", listener);
    const payload: TxConfirmedPayload = {
      txHash: "0x123",
      ledger: 45678,
      timestamp: Date.now(),
    };

    emitter.emit("tx_confirmed", payload);
    emitter.emit("tx_confirmed", payload);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(emitter.listenerCount("tx_confirmed")).toBe(0);
  });

  it("handles errors gracefully without breaking other listeners", () => {
    const emitter = createSdkEventEmitter();
    const badListener = vi.fn().mockImplementation(() => {
      throw new Error("Listener crash");
    });
    const goodListener = vi.fn();

    emitter.on("error", badListener);
    emitter.on("error", goodListener);

    const errorPayload: SdkErrorPayload = {
      code: "TX_FAILED",
      message: "Insufficient funds",
      timestamp: Date.now(),
    };

    expect(() => emitter.emit("error", errorPayload)).not.toThrow();
    expect(badListener).toHaveBeenCalled();
    expect(goodListener).toHaveBeenCalledWith(errorPayload);
  });
});
