import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  TransactionSigningSession,
  DEFAULT_SIGNING_SESSION_TIMEOUT_MS,
  signTransactionWithSession,
} from "../wallet/transactionSigningSession";
import { WalletType, type WalletAdapter } from "../wallet/types";
import { ok } from "../shared/response";

function mockAdapter(delayMs = 0, returnValue = "signed-xdr"): WalletAdapter {
  return {
    walletType: WalletType.FREIGHTER,
    isAvailable: () => true,
    connect: async () => ok("GAAAA"),
    disconnect: async () => ok(undefined),
    signTransaction: vi.fn(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(ok(returnValue)), delayMs);
        }),
    ),
  };
}

describe("TransactionSigningSession (#860)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("has a default timeout duration of at least 5 minutes", () => {
    const session = new TransactionSigningSession();
    expect(DEFAULT_SIGNING_SESSION_TIMEOUT_MS).toBeGreaterThanOrEqual(5 * 60 * 1000);
    expect(session.getTimeoutMs()).toBe(DEFAULT_SIGNING_SESSION_TIMEOUT_MS);
  });

  it("times out and returns an OPERATION_TIMEOUT SorokitResult error", async () => {
    const adapter = mockAdapter(10_000); // Takes 10s, but session timeout is 2s
    const onTimeout = vi.fn();
    const session = new TransactionSigningSession({
      timeoutMs: 2_000,
      onTimeout,
    });

    const promise = session.start(adapter, {
      transactionXdr: "AAAA",
      networkPassphrase: "Test SDF Network ; September 2015",
    });

    expect(session.getStatus()).toBe("pending");

    // Advance clock past 2 seconds
    vi.advanceTimersByTime(2_100);

    const result = await promise;
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe("OPERATION_TIMEOUT");
      expect(result.error.message).toContain("timed out after 2 seconds");
    }
    expect(session.getStatus()).toBe("timed_out");
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("completes successfully if wallet responds before timeout", async () => {
    const adapter = mockAdapter(500, "success-xdr");
    const session = new TransactionSigningSession({ timeoutMs: 5_000 });

    const promise = session.start(adapter, {
      transactionXdr: "AAAA",
      networkPassphrase: "Test SDF Network ; September 2015",
    });

    vi.advanceTimersByTime(600);

    const result = await promise;
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data).toBe("success-xdr");
    }
    expect(session.getStatus()).toBe("completed");
  });

  it("allows callers to cancel the pending session", async () => {
    const adapter = mockAdapter(10_000);
    const onCancel = vi.fn();
    const session = new TransactionSigningSession({
      timeoutMs: 5_000,
      onCancel,
    });

    const promise = session.start(adapter, {
      transactionXdr: "AAAA",
      networkPassphrase: "Test SDF Network ; September 2015",
    });

    expect(session.getStatus()).toBe("pending");

    const cancelResult = session.cancel("User closed prompt");
    expect(cancelResult.status).toBe("ok");
    expect(session.getStatus()).toBe("cancelled");
    expect(onCancel).toHaveBeenCalledTimes(1);

    const result = await promise;
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe("WALLET_SIGN_REJECTED");
      expect(result.error.message).toContain("User closed prompt");
    }
  });

  it("allows callers to extend the timeout while pending", async () => {
    const adapter = mockAdapter(5_000); // Takes 5s
    const session = new TransactionSigningSession({ timeoutMs: 2_000 }); // Initially 2s

    const promise = session.start(adapter, {
      transactionXdr: "AAAA",
      networkPassphrase: "Test SDF Network ; September 2015",
    });

    // Advance 1 second
    vi.advanceTimersByTime(1_000);

    // Extend by 6 more seconds (so 7s total from start)
    const extendResult = session.extendTimeout(6_000);
    expect(extendResult.status).toBe("ok");

    // Advance 2 more seconds (total 3s, which would have timed out under initial 2s limit)
    vi.advanceTimersByTime(2_000);
    expect(session.getStatus()).toBe("pending");

    // Advance 2.5 more seconds (total 5.5s, wallet responds at 5s)
    vi.advanceTimersByTime(2_500);

    const result = await promise;
    expect(result.status).toBe("ok");
    expect(session.getStatus()).toBe("completed");
  });

  it("allows callers to reset the timeout", async () => {
    const adapter = mockAdapter(4_000);
    const session = new TransactionSigningSession({ timeoutMs: 2_000 });

    const promise = session.start(adapter, {
      transactionXdr: "AAAA",
      networkPassphrase: "Test SDF Network ; September 2015",
    });

    // Advance 1.5 seconds
    vi.advanceTimersByTime(1_500);

    // Reset timeout for 5 seconds
    const resetResult = session.resetTimeout(5_000);
    expect(resetResult.status).toBe("ok");

    // Advance 3 more seconds
    vi.advanceTimersByTime(3_000);

    const result = await promise;
    expect(result.status).toBe("ok");
  });

  it("supports signTransactionWithSession helper", async () => {
    const adapter = mockAdapter(200, "helper-xdr");
    const promise = signTransactionWithSession(
      adapter,
      {
        transactionXdr: "AAAA",
        networkPassphrase: "Test SDF Network ; September 2015",
      },
      { timeoutMs: 1_000 },
    );

    vi.advanceTimersByTime(300);
    const result = await promise;
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data).toBe("helper-xdr");
    }
  });
});
