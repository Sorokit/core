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
    expect(second).toHaveBeenCalledTimes(4);
    unsubscribe();
    await tracker.disconnect(wallet);
    expect(listener.mock.calls.map(([state]) => state.status)).toEqual(["connecting", "authenticating", "connected", "connected", "connecting", "disconnected"]);
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

  it("handles 30-second connection timeout gracefully", async () => {
    vi.useFakeTimers();
    const tracker = new WalletStatusTracker();
    const hangingWallet: WalletAdapter = {
      walletType: WalletType.FREIGHTER,
      isAvailable: () => true,
      connect: () => new Promise(() => {}), // never resolves
      disconnect: async () => ok(undefined),
      signTransaction: async () => ok(""),
    };

    const connectPromise = tracker.connect(hangingWallet, { timeoutMs: 30000, maxRetries: 1 });
    await vi.advanceTimersByTimeAsync(30000);

    const result = await connectPromise;
    expect(result.status).toBe("error");
    expect(result.error.message).toContain("timed out after 30 seconds");
    expect(tracker.status.status).toBe("failed");
    expect(tracker.status.isTimeout).toBe(true);
    vi.useRealTimers();
  });

  it("handles retries with exponential backoff for transient errors", async () => {
    vi.useFakeTimers();
    const tracker = new WalletStatusTracker();
    let callCount = 0;
    const failingWallet: WalletAdapter = {
      walletType: WalletType.FREIGHTER,
      isAvailable: () => true,
      connect: async () => {
        callCount++;
        if (callCount < 3) {
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

    // Advance through backoff timers
    await vi.advanceTimersByTimeAsync(100); // 1st retry delay
    await vi.advanceTimersByTimeAsync(200); // 2nd retry delay

    const result = await connectPromise;
    expect(result.status).toBe("ok");
    expect(callCount).toBe(3);
    expect(tracker.isConnected).toBe(true);
    vi.useRealTimers();
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
