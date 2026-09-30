import { describe, expect, it, vi } from "vitest";
import { WalletStatusTracker, getAdapterName, getAriaLabel, getStatusColorClass, truncatePublicKey } from "../wallet/walletStatusTracker";
import { WalletType, type WalletAdapter } from "../wallet/types";
import { ok, err, SorokitErrorCode } from "../shared/response";

const key = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ";
function adapter(): WalletAdapter {
  return {
    walletType: WalletType.FREIGHTER,
    isAvailable: () => true,
    connect: vi.fn().mockResolvedValue(ok(key)),
    disconnect: vi.fn().mockResolvedValue(ok(undefined)),
    signTransaction: vi.fn(),
  };
}

describe("wallet status tracker", () => {
  it("publishes connecting, connected and disconnected states and unsubscribes", async () => {
    const listener = vi.fn();
    const tracker = new WalletStatusTracker({ onStatusChange: listener });
    const second = vi.fn();
    const unsubscribe = tracker.subscribe(second);
    const wallet = adapter();
    expect(tracker.isDisconnected).toBe(true);
    const connecting = tracker.connect(wallet);
    expect(tracker.isConnecting).toBe(true);
    expect(getAriaLabel(tracker.status)).toBe("Connecting to wallet");
    expect(await connecting).toMatchObject({ status: "ok", data: { publicKey: key, connected: true } });
    expect(tracker.isConnected).toBe(true);
    expect(getAriaLabel(tracker.status)).toContain("Freighter");
    expect(tracker.status.truncatedAddress).toBe(truncatePublicKey(key));
    const snapshot = tracker.status;
    snapshot.publicKey = "changed";
    expect(tracker.status.publicKey).toBe(key);
    expect(second).toHaveBeenCalledTimes(3);
    unsubscribe();
    await tracker.disconnect(wallet);
    expect(listener.mock.calls.map(([state]) => state.status)).toEqual(["connecting", "connected", "connected", "connecting", "disconnected"]);
    expect(getAriaLabel(tracker.status)).toBe("No wallet connected");
  });

  it("records failed connections and clears errors on restoration or reset", async () => {
    const tracker = new WalletStatusTracker();
    const wallet = adapter();
    vi.mocked(wallet.connect).mockResolvedValue(err(SorokitErrorCode.WALLET_CONNECT_FAILED, "denied"));
    expect((await tracker.connect(wallet, { maxRetries: 1 })).status).toBe("error");
    expect(tracker.hasError).toBe(true);
    expect(getAriaLabel(tracker.status)).toBe("Wallet error: denied");
    tracker.restoreState({ connected: true, publicKey: key, walletType: WalletType.FREIGHTER });
    expect(tracker.isConnected).toBe(true);
    tracker.setError("expired");
    expect(tracker.status.publicKey).toBeNull();
    tracker.setDisconnected();
    expect(tracker.isDisconnected).toBe(true);
    const listener = vi.fn();
    tracker.subscribe(listener);
    tracker.destroy();
    tracker.setError("after destroy");
    expect(listener).not.toHaveBeenCalled();
  });

  it("handles 30-second connection timeout gracefully on the FIRST attempt", async () => {
    vi.useFakeTimers();
    const tracker = new WalletStatusTracker();
    let connectCalls = 0;
    const hangingWallet: WalletAdapter = {
      walletType: WalletType.FREIGHTER,
      isAvailable: () => true,
      connect: () => {
        connectCalls++;
        return new Promise(() => {}); // never resolves
      },
      disconnect: async () => ok(undefined),
      signTransaction: async () => ok(""),
    };

    const connectPromise = tracker.connect(hangingWallet, { timeoutMs: 30000, maxRetries: 1 });
    await vi.advanceTimersByTimeAsync(30000);

    const result = await connectPromise;
    expect(connectCalls).toBe(1);
    expect(result.status).toBe("error");
    expect(result.error.message).toContain("timed out after 30 seconds");
    expect(tracker.status.status).toBe("failed");
    expect(tracker.status.isTimeout).toBe(true);
    vi.useRealTimers();
  });

  it("invokes adapter.connect() exactly ONCE on a successful first attempt", async () => {
    const tracker = new WalletStatusTracker();
    let connectCalls = 0;
    const quickWallet: WalletAdapter = {
      walletType: WalletType.FREIGHTER,
      isAvailable: () => true,
      connect: async () => {
        connectCalls++;
        return ok(key);
      },
      disconnect: async () => ok(undefined),
      signTransaction: async () => ok(""),
    };

    const progressStates: string[] = [];
    const result = await tracker.connect(quickWallet, {
      onProgress: (p) => progressStates.push(p.state),
    });

    expect(connectCalls).toBe(1);
    expect(result.status).toBe("ok");
    expect(tracker.isConnected).toBe(true);
    expect(progressStates).toEqual(["connecting", "connected"]);
  });

  it("handles retries with exponential backoff and exactly N calls", async () => {
    vi.useFakeTimers();
    const tracker = new WalletStatusTracker();
    let connectCalls = 0;
    const failingWallet: WalletAdapter = {
      walletType: WalletType.FREIGHTER,
      isAvailable: () => true,
      connect: async () => {
        connectCalls++;
        if (connectCalls < 3) {
          return err(SorokitErrorCode.WALLET_CONNECT_FAILED, "Transient network issue");
        }
        return ok(key);
      },
      disconnect: async () => ok(undefined),
      signTransaction: async () => ok(""),
    };

    const progressStates: string[] = [];
    const connectPromise = tracker.connect(failingWallet, {
      maxRetries: 3,
      backoffMs: 100,
      onProgress: (p) => progressStates.push(`${p.state}:attempt${p.attempt}`),
    });

    await vi.advanceTimersByTimeAsync(100); // 1st retry delay
    await vi.advanceTimersByTimeAsync(200); // 2nd retry delay

    const result = await connectPromise;
    expect(result.status).toBe("ok");
    expect(connectCalls).toBe(3);
    expect(tracker.isConnected).toBe(true);
    vi.useRealTimers();
  });

  it("prevents late promise resolution from corrupting state after timeout", async () => {
    vi.useFakeTimers();
    const tracker = new WalletStatusTracker();
    let resolveLateConnect: (value: any) => void;
    const slowWallet: WalletAdapter = {
      walletType: WalletType.FREIGHTER,
      isAvailable: () => true,
      connect: () =>
        new Promise((resolve) => {
          resolveLateConnect = resolve;
        }),
      disconnect: async () => ok(undefined),
      signTransaction: async () => ok(""),
    };

    const connectPromise = tracker.connect(slowWallet, { timeoutMs: 30000, maxRetries: 1 });
    await vi.advanceTimersByTimeAsync(30000);

    const result = await connectPromise;
    expect(result.status).toBe("error");
    expect(tracker.status.status).toBe("failed");

    // Late resolution fires after timeout
    resolveLateConnect!(ok(key));
    await Promise.resolve();

    // Verify state was NOT overwritten by late resolution
    expect(tracker.status.status).toBe("failed");
    expect(tracker.isConnected).toBe(false);
    vi.useRealTimers();
  });

  it("bypasses retries for non-retryable user rejection errors", async () => {
    const tracker = new WalletStatusTracker();
    let connectCalls = 0;
    const rejectingWallet: WalletAdapter = {
      walletType: WalletType.FREIGHTER,
      isAvailable: () => true,
      connect: async () => {
        connectCalls++;
        return err(SorokitErrorCode.WALLET_SIGN_REJECTED, "User rejected request");
      },
      disconnect: async () => ok(undefined),
      signTransaction: async () => ok(""),
    };

    const result = await tracker.connect(rejectingWallet, { maxRetries: 3 });
    expect(connectCalls).toBe(1);
    expect(result.status).toBe("error");
    expect(tracker.status.status).toBe("failed");
  });

  it.each([
    ["connected", "sorokit-status-ok"], ["connecting", "sorokit-status-pending"],
    ["disconnected", "sorokit-status-off"], ["error", "sorokit-status-error"],
  ] as const)("provides the %s presentation", (status, className) => {
    expect(getStatusColorClass(status)).toBe(className);
    expect(getAdapterName(WalletType.FREIGHTER)).toBe("Freighter");
    expect(truncatePublicKey("short")).toBe("short");
  });
});
