import { describe, expect, it, vi } from "vitest";
import { WalletConnectionManager } from "./connection";
import { ok } from "../shared/response";
import { WalletType, type WalletAdapter } from "./types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function adapter(overrides: Partial<WalletAdapter> = {}): WalletAdapter {
  return {
    walletType: WalletType.FREIGHTER,
    isAvailable: () => true,
    connect: async () => ok("GABC"),
    disconnect: async () => ok(undefined),
    signTransaction: async () => ok("signed-xdr"),
    ...overrides,
  };
}

describe("WalletConnectionManager", () => {
  it("cleans up a stale connection result after disconnect", async () => {
    const first = deferred<ReturnType<typeof ok<string>>>();
    const disconnect = vi.fn(async () => ok(undefined));
    const wallet = adapter({ connect: () => first.promise, disconnect });
    const manager = new WalletConnectionManager(wallet);

    const connecting = manager.connect();
    const disconnecting = manager.disconnect();
    first.resolve(ok("GOLD"));

    const [connectResult, disconnectResult] = await Promise.all([connecting, disconnecting]);
    expect(connectResult.status).toBe("error");
    expect(disconnectResult.status).toBe("ok");
    expect(manager.state.connected).toBe(false);
    expect(disconnect).toHaveBeenCalledTimes(2);
  });

  it("serializes disconnect before a subsequent reconnect", async () => {
    const events: string[] = [];
    const disconnectGate = deferred<ReturnType<typeof ok<undefined>>>();
    const wallet = adapter({
      connect: vi.fn(async () => { events.push("connect"); return ok("GABC"); }),
      disconnect: vi.fn(() => { events.push("disconnect-start"); return disconnectGate.promise; }),
    });
    const manager = new WalletConnectionManager(wallet);

    const disconnecting = manager.disconnect();
    const reconnecting = manager.connect();
    await Promise.resolve();
    expect(events).toEqual(["disconnect-start"]);

    disconnectGate.resolve(ok(undefined));
    const [disconnected, connected] = await Promise.all([disconnecting, reconnecting]);
    expect(disconnected.status).toBe("ok");
    expect(connected.status).toBe("ok");
    expect(events).toEqual(["disconnect-start", "connect"]);
    expect(manager.state.connected).toBe(true);
  });
});
