import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import {
  subscribePrices,
  computeBackoffDelay,
  type PriceSubscriptionProvider,
  type PriceUpdate,
} from "../transaction/priceSubscriptions";
import { normalizeAsset } from "../transaction/priceFeeds";

// ─── Mock provider factory ─────────────────────────────────────────────────────

function makeMockProvider(name = "mock"): PriceSubscriptionProvider & {
  triggerMessage(update: PriceUpdate): void;
  triggerClose(wasClean: boolean): void;
  triggerError(error: Error): void;
  connectCalled: number;
  disconnectCalled: number;
  failNextConnect: boolean;
} {
  let messageHandler: ((u: PriceUpdate) => void) | null = null;
  let closeHandler: ((wasClean: boolean) => void) | null = null;
  let errorHandler: ((e: Error) => void) | null = null;
  let connectCalled = 0;
  let disconnectCalled = 0;
  let failNextConnect = false;

  return {
    get connectCalled() { return connectCalled; },
    get disconnectCalled() { return disconnectCalled; },
    get failNextConnect() { return failNextConnect; },
    set failNextConnect(v) { failNextConnect = v; },
    name,
    async connect() {
      connectCalled++;
      if (failNextConnect) {
        failNextConnect = false;
        throw new Error(`${name} connect failed`);
      }
    },
    disconnect() { disconnectCalled++; },
    subscribe(_assets) {},
    onMessage(h) { messageHandler = h; },
    onClose(h) { closeHandler = h; },
    onError(h) { errorHandler = h; },
    triggerMessage(u) { messageHandler?.(u); },
    triggerClose(wasClean) { closeHandler?.(wasClean); },
    triggerError(e) { errorHandler?.(e); },
  };
}

function sampleUpdate(asset = "XLM"): PriceUpdate {
  return {
    asset,
    price: 0.12,
    currency: "USD",
    provider: "mock",
    timestamp: new Date().toISOString(),
    status: "fresh",
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("subscribePrices", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("throws synchronously when assets array is empty", () => {
    expect(() => subscribePrices([], vi.fn())).toThrow(/non-empty/);
  });

  it("delivers a PriceUpdate with correct fields to the callback", async () => {
    const provider = makeMockProvider();
    const callback = vi.fn();

    subscribePrices(["XLM"], callback, { providers: [provider] });
    await Promise.resolve(); // let connect() settle

    const update = sampleUpdate("XLM");
    provider.triggerMessage(update);

    expect(callback).toHaveBeenCalledOnce();
    const received = callback.mock.calls[0][0] as PriceUpdate;
    expect(received.asset).toBe("XLM");
    expect(received.price).toBe(0.12);
    expect(received.currency).toBe("USD");
    expect(received.provider).toBe("mock");
    expect(received.status).toBe("fresh");
    expect(typeof received.timestamp).toBe("string");
  });

  it("normalises asset strings before subscribing", async () => {
    const provider = makeMockProvider();
    const subscribeSpy = vi.spyOn(provider, "subscribe");

    subscribePrices(["native", "xlm"], vi.fn(), { providers: [provider] });
    await Promise.resolve();

    expect(subscribeSpy).toHaveBeenCalledWith(["XLM", "XLM"]);
  });

  it("does not invoke callback after unsubscribe()", async () => {
    const provider = makeMockProvider();
    const callback = vi.fn();

    const sub = subscribePrices(["XLM"], callback, { providers: [provider] });
    await Promise.resolve();

    sub.unsubscribe();
    provider.triggerMessage(sampleUpdate("XLM"));

    expect(callback).not.toHaveBeenCalled();
  });

  it("unsubscribe() is idempotent", async () => {
    const provider = makeMockProvider();
    const sub = subscribePrices(["XLM"], vi.fn(), { providers: [provider] });
    await Promise.resolve();

    expect(() => {
      sub.unsubscribe();
      sub.unsubscribe();
      sub.unsubscribe();
    }).not.toThrow();
  });

  it("schedules a reconnect after unexpected close", async () => {
    const provider = makeMockProvider();
    subscribePrices(["XLM"], vi.fn(), {
      providers: [provider],
      baseDelayMs: 100,
      maxDelayMs: 1000,
      maxRetries: 3,
    });
    await Promise.resolve();
    expect(provider.connectCalled).toBe(1);

    provider.triggerClose(false); // non-clean close → should reconnect

    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    expect(provider.connectCalled).toBeGreaterThanOrEqual(2);
  });

  it("does NOT reconnect after clean close", async () => {
    const provider = makeMockProvider();
    subscribePrices(["XLM"], vi.fn(), { providers: [provider] });
    await Promise.resolve();

    provider.triggerClose(true); // clean → no reconnect

    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();

    expect(provider.connectCalled).toBe(1);
  });

  it("cancels reconnect timer when unsubscribed", async () => {
    const provider = makeMockProvider();
    const sub = subscribePrices(["XLM"], vi.fn(), {
      providers: [provider],
      baseDelayMs: 500,
    });
    await Promise.resolve();

    provider.triggerClose(false);
    sub.unsubscribe(); // cancel before timer fires

    await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();

    expect(provider.connectCalled).toBe(1); // no extra reconnects
  });

  it("falls back to second provider when first exhausts retries", async () => {
    const p1 = makeMockProvider("primary");
    const p2 = makeMockProvider("fallback");
    const onProviderChange = vi.fn();

    // Make p1 always fail to connect
    vi.spyOn(p1, "connect").mockRejectedValue(new Error("primary unavailable"));

    subscribePrices(["XLM"], vi.fn(), {
      providers: [p1, p2],
      baseDelayMs: 50,
      maxDelayMs: 200,
      maxRetries: 1,
      onProviderChange,
    });

    // First connect attempt for p1 fails → schedules retry
    await Promise.resolve();

    // Advance through retries so p1 exhausts maxRetries and we switch to p2
    await vi.advanceTimersByTimeAsync(2000);
    await Promise.resolve();
    await Promise.resolve();

    expect(onProviderChange).toHaveBeenCalledWith("fallback");
  });

  it("invokes onError when no providers are configured", async () => {
    const onError = vi.fn();
    subscribePrices(["XLM"], vi.fn(), { providers: [], onError });
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it("auto-unsubscribes when AbortSignal is aborted", async () => {
    const provider = makeMockProvider();
    const controller = new AbortController();
    const callback = vi.fn();

    subscribePrices(["XLM"], callback, {
      providers: [provider],
      signal: controller.signal,
    });
    await Promise.resolve();

    controller.abort();
    provider.triggerMessage(sampleUpdate("XLM"));

    expect(callback).not.toHaveBeenCalled();
    expect(provider.disconnectCalled).toBeGreaterThanOrEqual(1);
  });

  it("resets retry counter to zero after successful reconnect", async () => {
    const provider = makeMockProvider();
    subscribePrices(["XLM"], vi.fn(), {
      providers: [provider],
      baseDelayMs: 50,
      maxRetries: 5,
    });
    await Promise.resolve();
    expect(provider.connectCalled).toBe(1);

    // Trigger one disconnect → reconnect succeeds → retry should reset
    provider.triggerClose(false);
    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();

    // Trigger another disconnect — should start retry count fresh (not fail immediately)
    provider.triggerClose(false);
    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();

    expect(provider.connectCalled).toBeGreaterThanOrEqual(3);
  });
});

// ─── computeBackoffDelay ───────────────────────────────────────────────────────

describe("computeBackoffDelay", () => {
  it("returns baseDelayMs for attempt 0", () => {
    expect(computeBackoffDelay(0, 250, 30_000)).toBe(250);
  });

  it("doubles each attempt", () => {
    expect(computeBackoffDelay(1, 250, 30_000)).toBe(500);
    expect(computeBackoffDelay(2, 250, 30_000)).toBe(1000);
  });

  it("caps at maxDelayMs", () => {
    expect(computeBackoffDelay(100, 250, 30_000)).toBe(30_000);
  });

  // Property-based: delay always within [baseDelayMs, maxDelayMs]
  it("property: delay always in [baseDelayMs, maxDelayMs]", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 30 }),
        fc.integer({ min: 1, max: 1000 }),
        fc.integer({ min: 1000, max: 60_000 }),
        (attempt, base, max) => {
          const delay = computeBackoffDelay(attempt, base, max);
          return delay >= base && delay <= max;
        },
      ),
    );
  });
});

// ─── Property-based: callback delivery ────────────────────────────────────────

describe("subscribePrices property-based", () => {
  it("callback is invoked exactly once per message, asset normalised", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom("XLM", "USDC", "native", "xlm"), { minLength: 1, maxLength: 4 }),
        fc.array(
          fc.record({
            asset: fc.constantFrom("XLM", "USDC", "XLM"),
            price: fc.double({ min: 0.0001, max: 1000, noNaN: true }),
            currency: fc.constant("USD"),
            provider: fc.constant("mock"),
            timestamp: fc.constant(new Date().toISOString()),
            status: fc.constant("fresh" as const),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        async (assets, messages) => {
          const provider = makeMockProvider();
          const received: PriceUpdate[] = [];

          subscribePrices(assets, (u) => received.push(u), { providers: [provider] });
          await Promise.resolve();

          for (const msg of messages) {
            provider.triggerMessage(msg);
          }

          // Exactly one call per message
          if (received.length !== messages.length) return false;

          // asset field matches normalised form
          return received.every(
            (u, i) => u.asset === normalizeAsset(messages[i].asset),
          );
        },
      ),
    );
  });
});
