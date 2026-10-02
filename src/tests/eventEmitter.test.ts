import { describe, it, expect, vi } from "vitest";
import { ok } from "../shared/response";
import {
  WalletEventEmitter,
  createWalletEventEmitter,
  toConnectedEvent,
} from "../wallet/eventEmitter";
import { WalletType } from "../wallet/types";
import type { WalletAdapter } from "../wallet/types";
import { createSorokitClient } from "../client/createSorokitClient";

const VALID_KEY = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA";

function fakeAdapter(overrides?: Partial<WalletAdapter>): WalletAdapter {
  return {
    walletType: WalletType.FREIGHTER,
    isAvailable: () => true,
    connect: async () => ok(VALID_KEY),
    disconnect: async () => ok(undefined),
    signTransaction: async () => ok("signed"),
    ...overrides,
  };
}

describe("WalletEventEmitter (#613)", () => {
  it("delivers an emitted event to a subscribed listener", () => {
    const emitter = new WalletEventEmitter();
    const listener = vi.fn();
    emitter.on("connected", listener);

    emitter.emit("connected", { walletType: WalletType.FREIGHTER, publicKey: VALID_KEY });

    expect(listener).toHaveBeenCalledWith({
      walletType: WalletType.FREIGHTER,
      publicKey: VALID_KEY,
    });
  });

  it("does not deliver events for a different event name", () => {
    const emitter = new WalletEventEmitter();
    const connectedListener = vi.fn();
    const disconnectedListener = vi.fn();
    emitter.on("connected", connectedListener);
    emitter.on("disconnected", disconnectedListener);

    emitter.emit("connected", { walletType: WalletType.FREIGHTER, publicKey: VALID_KEY });

    expect(connectedListener).toHaveBeenCalledTimes(1);
    expect(disconnectedListener).not.toHaveBeenCalled();
  });

  it("stops delivering events after the unsubscribe function is called", () => {
    const emitter = new WalletEventEmitter();
    const listener = vi.fn();
    const unsubscribe = emitter.on("disconnected", listener);

    unsubscribe();
    emitter.emit("disconnected", { walletType: WalletType.FREIGHTER });

    expect(listener).not.toHaveBeenCalled();
  });

  it("stops delivering events after off() is called with the same listener reference", () => {
    const emitter = new WalletEventEmitter();
    const listener = vi.fn();
    emitter.on("disconnected", listener);

    emitter.off("disconnected", listener);
    emitter.emit("disconnected", { walletType: WalletType.FREIGHTER });

    expect(listener).not.toHaveBeenCalled();
  });

  it("supports multiple listeners for the same event", () => {
    const emitter = new WalletEventEmitter();
    const first = vi.fn();
    const second = vi.fn();
    emitter.on("accountChanged", first);
    emitter.on("accountChanged", second);

    emitter.emit("accountChanged", { activeAccount: null, previousAccount: null });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("does not let a throwing listener prevent other listeners from running", () => {
    const emitter = new WalletEventEmitter();
    const throwing = vi.fn(() => {
      throw new Error("boom");
    });
    const healthy = vi.fn();
    emitter.on("connected", throwing);
    emitter.on("connected", healthy);

    expect(() =>
      emitter.emit("connected", { walletType: WalletType.FREIGHTER, publicKey: VALID_KEY }),
    ).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it("removeAllListeners(event) clears only that event's listeners", () => {
    const emitter = new WalletEventEmitter();
    const connectedListener = vi.fn();
    const disconnectedListener = vi.fn();
    emitter.on("connected", connectedListener);
    emitter.on("disconnected", disconnectedListener);

    emitter.removeAllListeners("connected");
    emitter.emit("connected", { walletType: WalletType.FREIGHTER, publicKey: VALID_KEY });
    emitter.emit("disconnected", { walletType: WalletType.FREIGHTER });

    expect(connectedListener).not.toHaveBeenCalled();
    expect(disconnectedListener).toHaveBeenCalledTimes(1);
  });

  it("removeAllListeners() with no argument clears every event", () => {
    const emitter = new WalletEventEmitter();
    const connectedListener = vi.fn();
    const disconnectedListener = vi.fn();
    emitter.on("connected", connectedListener);
    emitter.on("disconnected", disconnectedListener);

    emitter.removeAllListeners();
    emitter.emit("connected", { walletType: WalletType.FREIGHTER, publicKey: VALID_KEY });
    emitter.emit("disconnected", { walletType: WalletType.FREIGHTER });

    expect(connectedListener).not.toHaveBeenCalled();
    expect(disconnectedListener).not.toHaveBeenCalled();
  });

  it("createWalletEventEmitter returns a working standalone instance", () => {
    const emitter = createWalletEventEmitter();
    const listener = vi.fn();
    emitter.on("networkChanged", listener);

    emitter.emit("networkChanged", {
      walletType: WalletType.FREIGHTER,
      previousNetwork: "testnet",
      network: "mainnet",
    });

    expect(listener).toHaveBeenCalledWith({
      walletType: WalletType.FREIGHTER,
      previousNetwork: "testnet",
      network: "mainnet",
    });
  });
});

describe("toConnectedEvent", () => {
  it("returns the connected event payload for a connected WalletState", () => {
    const event = toConnectedEvent({
      connected: true,
      publicKey: VALID_KEY,
      walletType: WalletType.FREIGHTER,
    });
    expect(event).toEqual({ walletType: WalletType.FREIGHTER, publicKey: VALID_KEY });
  });

  it("returns null for a disconnected WalletState", () => {
    const event = toConnectedEvent({ connected: false, publicKey: null, walletType: null });
    expect(event).toBeNull();
  });

  it("returns null when connected is true but publicKey is missing (defensive)", () => {
    const event = toConnectedEvent({
      connected: true,
      publicKey: null,
      walletType: WalletType.FREIGHTER,
    });
    expect(event).toBeNull();
  });
});

describe("Client Integration (#613)", () => {
  it("emits 'connected' through client.wallet when connect() succeeds", async () => {
    const clientResult = createSorokitClient({ network: "testnet" });
    expect(clientResult.status).toBe("ok");
    if (clientResult.status !== "ok") return;
    const client = clientResult.data;

    const listener = vi.fn();
    client.wallet.on("connected", listener);

    const adapter = fakeAdapter();
    const connectResult = await client.wallet.connect(adapter);

    expect(connectResult.status).toBe("ok");
    expect(listener).toHaveBeenCalledWith({
      walletType: WalletType.FREIGHTER,
      publicKey: VALID_KEY,
    });
  });

  it("does not emit 'connected' when connect() fails", async () => {
    const clientResult = createSorokitClient({ network: "testnet" });
    expect(clientResult.status).toBe("ok");
    if (clientResult.status !== "ok") return;
    const client = clientResult.data;

    const listener = vi.fn();
    client.wallet.on("connected", listener);

    const adapter = fakeAdapter({ isAvailable: () => false });
    await client.wallet.connect(adapter);

    expect(listener).not.toHaveBeenCalled();
  });

  it("emits 'disconnected' through client.wallet when disconnect() succeeds", async () => {
    const clientResult = createSorokitClient({ network: "testnet" });
    expect(clientResult.status).toBe("ok");
    if (clientResult.status !== "ok") return;
    const client = clientResult.data;

    const listener = vi.fn();
    client.wallet.on("disconnected", listener);

    const adapter = fakeAdapter();
    await client.wallet.disconnect(adapter);

    expect(listener).toHaveBeenCalledWith({ walletType: WalletType.FREIGHTER });
  });

  it("emits 'accountChanged' through client.wallet when the active account switches", async () => {
    const clientResult = createSorokitClient({ network: "testnet" });
    expect(clientResult.status).toBe("ok");
    if (clientResult.status !== "ok") return;
    const client = clientResult.data;

    const listener = vi.fn();
    client.wallet.on("accountChanged", listener);

    await client.wallet.addAccount(VALID_KEY, { label: "Main" });

    expect(listener).toHaveBeenCalledTimes(1);
    const payload = listener.mock.calls[0][0];
    expect(payload.activeAccount?.publicKey).toBe(VALID_KEY);
    expect(payload.previousAccount).toBeNull();
  });

  it("off() stops delivering further wallet events through client.wallet", async () => {
    const clientResult = createSorokitClient({ network: "testnet" });
    expect(clientResult.status).toBe("ok");
    if (clientResult.status !== "ok") return;
    const client = clientResult.data;

    const listener = vi.fn();
    client.wallet.on("connected", listener);
    client.wallet.off("connected", listener);

    await client.wallet.connect(fakeAdapter());

    expect(listener).not.toHaveBeenCalled();
  });
});
