import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  streamAccountUpdates,
  streamPayments,
  type EventSourceLike,
  type HorizonAccountUpdateEvent,
  type HorizonPaymentStreamEvent,
} from "../network/streaming";

interface MockEventSourceInstance extends EventSourceLike {
  url: string;
  closed: boolean;
  emitMessage(data: Record<string, unknown>, lastEventId?: string): void;
  emitRawMessage(data: string, lastEventId?: string): void;
  emitError(error?: Error): void;
}

function createMockEventSourceFactory() {
  const instances: MockEventSourceInstance[] = [];
  const factory = (url: string): EventSourceLike => {
    const instance: MockEventSourceInstance = {
      url,
      closed: false,
      onmessage: null,
      onerror: null,
      onopen: null,
      close() {
        instance.closed = true;
      },
      emitMessage(data: Record<string, unknown>, lastEventId?: string) {
        instance.onmessage?.({
          data: JSON.stringify(data),
          ...(lastEventId !== undefined ? { lastEventId } : {}),
        });
      },
      emitRawMessage(data: string, lastEventId?: string) {
        instance.onmessage?.({
          data,
          ...(lastEventId !== undefined ? { lastEventId } : {}),
        });
      },
      emitError(error?: Error) {
        instance.onerror?.(error ?? new Error("SSE stream dropped"));
      },
    };
    instances.push(instance);
    return instance;
  };
  return { factory, instances };
}

describe("Horizon SSE Streaming (#929)", () => {
  const validPublicKey = Keypair.random().publicKey();

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("streams real-time account updates and updates the cursor", () => {
    const { factory, instances } = createMockEventSourceFactory();
    const events: HorizonAccountUpdateEvent[] = [];

    const result = streamAccountUpdates(validPublicKey, {
      horizonUrl: "https://horizon-testnet.stellar.org",
      cursor: "now",
      eventSourceFactory: factory,
      onEvent: (event) => events.push(event),
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const sub = result.data;
    expect(sub.isConnected()).toBe(true);
    expect(instances).toHaveLength(1);
    expect(instances[0]!.url).toContain(`/accounts/${validPublicKey}?cursor=now`);

    instances[0]!.emitMessage({
      id: validPublicKey,
      account_id: validPublicKey,
      sequence: "12345",
      paging_token: "cursor-101",
      balances: [
        { asset_type: "native", balance: "250.5000000" },
        {
          asset_type: "credit_alphanum4",
          asset_code: "USDC",
          asset_issuer: validPublicKey,
          balance: "99.0000000",
        },
      ],
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.sequence).toBe("12345");
    expect(events[0]!.pagingToken).toBe("cursor-101");
    expect(events[0]!.balances).toHaveLength(2);
    expect(sub.getCursor()).toBe("cursor-101");

    sub.close();
    expect(sub.isConnected()).toBe(false);
    expect(instances[0]!.closed).toBe(true);
  });

  it("streams real-time payments and automatically reconnects from the last cursor", () => {
    const { factory, instances } = createMockEventSourceFactory();
    const payments: HorizonPaymentStreamEvent[] = [];
    const reconnects: Array<{ attempt: number; cursor: string }> = [];
    const errors: Error[] = [];

    const result = streamPayments(validPublicKey, {
      horizonUrl: "https://horizon-testnet.stellar.org",
      cursor: "initial-cursor",
      reconnectBaseDelayMs: 200,
      maxReconnectAttempts: 3,
      eventSourceFactory: factory,
      onEvent: (event) => payments.push(event),
      onError: (err) => errors.push(err),
      onReconnect: (attempt, cursor) => reconnects.push({ attempt, cursor }),
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const sub = result.data;

    instances[0]!.emitMessage({
      id: "pay-1",
      paging_token: "pt-500",
      type: "payment",
      from: validPublicKey,
      to: validPublicKey,
      amount: "42.0000000",
      asset_type: "native",
      transaction_hash: "tx-abc",
    });

    expect(payments).toHaveLength(1);
    expect(payments[0]!.amount).toBe("42.0000000");
    expect(sub.getCursor()).toBe("pt-500");

    // Simulate connection drop
    instances[0]!.emitError(new Error("Connection reset"));
    expect(errors).toHaveLength(1);
    expect(reconnects).toEqual([{ attempt: 1, cursor: "pt-500" }]);
    expect(sub.getReconnectCount()).toBe(1);

    vi.advanceTimersByTime(200);
    expect(instances).toHaveLength(2);
    expect(instances[1]!.url).toContain("cursor=pt-500");

    sub.close();
  });

  it("rejects invalid public keys without throwing", () => {
    const res1 = streamAccountUpdates("invalid-key", { onEvent: () => {} });
    expect(res1.status).toBe("error");
    if (res1.status === "error") {
      expect(res1.error.code).toBe("INVALID_ADDRESS");
    }

    const res2 = streamPayments("S" + "A".repeat(55), { onEvent: () => {} });
    expect(res2.status).toBe("error");
  });
});
