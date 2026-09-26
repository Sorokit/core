import { afterEach, describe, expect, it, vi } from "vitest";
import { RabetAdapter, type RabetProvider } from "./rabet";
import { RabetAdapter as ExportedAdapter } from "./index";
import { RabetAdapter as RootAdapter } from "../../index";
import { RabetAdapter as WalletAdapter } from "../index";
import { connectWallet } from "../connect";
import { disconnectWallet } from "../disconnect";
import { WalletType, type SWKInstance } from "../types";

const input = { transactionXdr: "unsigned", networkPassphrase: "Test SDF Network ; September 2015" };
function provider() {
  return {
    connect: vi.fn().mockResolvedValue({ publicKey: "GACCOUNT" }),
    sign: vi.fn().mockResolvedValue({ xdr: "signed" }),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
}
const error = (code: string) => ({ status: "error", error: expect.objectContaining({ code }) });
afterEach(() => vi.unstubAllGlobals());

describe("Rabet protocol", () => {
  it("exports the adapter from all public entry points", () => {
    expect(ExportedAdapter).toBe(RabetAdapter);
    expect(RootAdapter).toBe(RabetAdapter);
    expect(WalletAdapter).toBe(RabetAdapter);
  });

  it("resolves a late-injected extension and manages the wallet session", async () => {
    vi.stubGlobal("window", {});
    const adapter = new RabetAdapter();
    expect(adapter.isAvailable()).toBe(false);
    const native = provider();
    vi.stubGlobal("window", { rabet: native });
    expect(adapter.isAvailable()).toBe(true);
    expect(await connectWallet(adapter)).toMatchObject({ status: "ok", data: {
      publicKey: "GACCOUNT", connected: true, walletType: WalletType.RABET,
    } });
    expect(await adapter.signTransaction(input)).toMatchObject({ status: "ok", data: "signed" });
    expect(await disconnectWallet(adapter)).toMatchObject({ status: "ok", data: {
      connected: false, publicKey: null, walletType: null,
    } });
    expect(native.disconnect).toHaveBeenCalledOnce();
    expect(await adapter.connect()).toMatchObject({ status: "ok" });
    expect(native.connect).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["Test SDF Network ; September 2015", "testnet"],
    ["Public Global Stellar Network ; September 2015", "mainnet"],
  ])("passes %s as %s to native signing", async (networkPassphrase, network) => {
    const native = provider();
    await new RabetAdapter(native).signTransaction({ ...input, networkPassphrase });
    expect(native.sign).toHaveBeenCalledWith("unsigned", network);
  });

  it("rejects custom networks without asking the extension to sign", async () => {
    const native = provider();
    expect(await new RabetAdapter(native).signTransaction({ ...input, networkPassphrase: "custom" }))
      .toMatchObject(error("INVALID_NETWORK"));
    expect(native.sign).not.toHaveBeenCalled();
  });

  it.each(["signed", { xdr: "signed" }, { signedTxXdr: "signed" }])("normalizes signing response %j", async (result) => {
    const native = provider();
    native.sign.mockResolvedValue(result);
    expect(await new RabetAdapter(native).signTransaction(input)).toMatchObject({ status: "ok", data: "signed" });
  });

  it.each(["GACCOUNT", { publicKey: "GACCOUNT" }])("normalizes account response %j", async (result) => {
    const native = provider();
    native.connect.mockResolvedValue(result);
    expect(await new RabetAdapter(native).connect()).toMatchObject({ status: "ok", data: "GACCOUNT" });
  });

  it.each([undefined, null, "", "  ", 42, {}])("rejects malformed values %j", async (value) => {
    const native = provider();
    native.connect.mockResolvedValue({ publicKey: value });
    native.sign.mockResolvedValue({ xdr: value });
    const adapter = new RabetAdapter(native);
    expect(await adapter.connect()).toMatchObject(error("WALLET_CONNECT_FAILED"));
    expect(await adapter.signTransaction(input)).toMatchObject(error("WALLET_SIGN_FAILED"));
    const kit: SWKInstance = {
      getAddress: vi.fn().mockResolvedValue({ address: value }),
      signTransaction: vi.fn().mockResolvedValue({ signedTxXdr: value }),
    };
    expect(await new RabetAdapter(kit).connect()).toMatchObject(error("WALLET_CONNECT_FAILED"));
    expect(await new RabetAdapter(kit).signTransaction(input)).toMatchObject(error("WALLET_SIGN_FAILED"));
  });

  it("delegates SWK account discovery and signing options", async () => {
    const kit: SWKInstance = {
      getAddress: vi.fn().mockResolvedValue({ address: "GACCOUNT" }),
      signTransaction: vi.fn().mockResolvedValue({ signedTxXdr: "signed" }),
    };
    const adapter = new RabetAdapter(kit);
    expect(adapter.isAvailable()).toBe(true);
    expect(await adapter.connect()).toMatchObject({ status: "ok", data: "GACCOUNT" });
    expect(await adapter.signTransaction({ ...input, accountToSign: "GACCOUNT" }))
      .toMatchObject({ status: "ok", data: "signed" });
    expect(kit.signTransaction).toHaveBeenCalledWith("unsigned", {
      networkPassphrase: input.networkPassphrase, address: "GACCOUNT",
    });
    expect(await adapter.disconnect()).toMatchObject({ status: "ok", data: undefined });
  });

  it.each(["User rejected", "User cancelled", "Permission denied"])("maps resolved and thrown rejection: %s", async (message) => {
    const native = provider();
    const adapter = new RabetAdapter(native);
    native.connect.mockResolvedValue({ error: message });
    native.sign.mockResolvedValue({ error: message });
    expect(await adapter.connect()).toMatchObject(error("WALLET_SIGN_REJECTED"));
    expect(await adapter.signTransaction(input)).toMatchObject(error("WALLET_SIGN_REJECTED"));
    native.connect.mockRejectedValue(new Error(message));
    native.sign.mockRejectedValue(new Error(message));
    expect(await adapter.connect()).toMatchObject(error("WALLET_SIGN_REJECTED"));
    expect(await adapter.signTransaction(input)).toMatchObject(error("WALLET_SIGN_REJECTED"));
  });

  it.each([undefined, null, new Error("IPC failed"), { error: "unavailable" }])("never throws on provider failure %j", async (cause) => {
    const native = provider();
    native.connect.mockRejectedValue(cause);
    native.sign.mockRejectedValue(cause);
    native.disconnect.mockRejectedValue(cause);
    const adapter = new RabetAdapter(native);
    expect(await adapter.connect()).toMatchObject(error("WALLET_CONNECT_FAILED"));
    expect(await adapter.signTransaction(input)).toMatchObject(error("WALLET_SIGN_FAILED"));
    expect(await adapter.disconnect()).toMatchObject(error("WALLET_CONNECT_FAILED"));
  });

  it("contains throwing extension getters", async () => {
    vi.stubGlobal("window", Object.defineProperty({}, "rabet", { get() { throw new Error("access denied by runtime"); } }));
    const adapter = new RabetAdapter();
    expect(adapter.isAvailable()).toBe(false);
    expect((await adapter.connect()).status).toBe("error");
    expect((await adapter.signTransaction(input)).status).toBe("error");
    expect((await adapter.disconnect()).status).toBe("error");
  });

  it("contains throwing provider method getters", async () => {
    const native = new Proxy({} as RabetProvider, { has() { throw new Error("IPC failed"); } });
    const adapter = new RabetAdapter(native);
    expect(adapter.isAvailable()).toBe(false);
    expect(await adapter.connect()).toMatchObject(error("WALLET_CONNECT_FAILED"));
    expect(await adapter.signTransaction(input)).toMatchObject(error("WALLET_SIGN_FAILED"));
    expect(await adapter.disconnect()).toMatchObject(error("WALLET_CONNECT_FAILED"));
  });

  it("handles an absent extension and optional disconnect", async () => {
    vi.stubGlobal("window", undefined);
    const adapter = new RabetAdapter();
    expect(adapter.isAvailable()).toBe(false);
    expect(await adapter.connect()).toMatchObject(error("WALLET_BROWSER_ONLY"));
    expect(await adapter.signTransaction(input)).toMatchObject(error("WALLET_BROWSER_ONLY"));
    expect(await adapter.disconnect()).toMatchObject({ status: "ok" });
    const { disconnect: _, ...native } = provider();
    expect(await new RabetAdapter(native).disconnect()).toMatchObject({ status: "ok" });
  });
});
