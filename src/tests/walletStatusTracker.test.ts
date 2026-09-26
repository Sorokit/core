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
    unsubscribe();
    await tracker.disconnect(wallet);
    expect(second).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls.map(([state]) => state.status)).toEqual(["connecting", "connected", "connecting", "disconnected"]);
    expect(getAriaLabel(tracker.status)).toBe("No wallet connected");
  });

  it("records failed connections and clears errors on restoration or reset", async () => {
    const tracker = new WalletStatusTracker();
    const wallet = adapter();
    vi.mocked(wallet.connect).mockResolvedValue(err(SorokitErrorCode.WALLET_CONNECT_FAILED, "denied"));
    expect((await tracker.connect(wallet)).status).toBe("error");
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

  it.each([
    ["connected", "sorokit-status-ok"], ["connecting", "sorokit-status-pending"],
    ["disconnected", "sorokit-status-off"], ["error", "sorokit-status-error"],
  ] as const)("provides the %s presentation", (status, className) => {
    expect(getStatusColorClass(status)).toBe(className);
    expect(getAdapterName(WalletType.FREIGHTER)).toBe("Freighter");
    expect(truncatePublicKey("short")).toBe("short");
  });
});
