import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPathPaymentTransaction } from "../transaction/pathPayment";
import { equalContractDataKeys, serializeContractDataKey } from "../soroban/contractData";
import { StreamEventEmitter } from "../streaming/streamEventEmitter";
import { ok } from "../shared/response";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import type { ResolvedNetworkConfig } from "../shared/types";
import type { TrustlineParams } from "../transaction/types";

const validateTrustlineMock = vi.hoisted(() => vi.fn());
const buildTrustlineTransactionMock = vi.hoisted(() => vi.fn());
vi.mock("../transaction/buildTransaction", () => ({
  validateTrustline: validateTrustlineMock,
  buildTrustlineTransaction: buildTrustlineTransactionMock,
}));

import { TrustlineManager } from "../transaction/trustlineManager";

const VALID_KEY = Keypair.random().publicKey();
const NETWORK_CONFIG: ResolvedNetworkConfig = {
  network: "testnet",
  horizonUrl: "https://horizon-testnet.stellar.org",
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: Networks.TESTNET,
};

const trustline: TrustlineParams = { assetCode: "USDC", assetIssuer: Keypair.random().publicKey() };

describe("issue #831 path payment self-payment validation", () => {
  it("warns by default and supports an explicit hard error", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const params = {
      sourcePublicKey: VALID_KEY,
      destination: VALID_KEY,
      sendAssetCode: "XLM",
      sendAssetIssuer: null,
      destAssetCode: "USDC",
      destAssetIssuer: trustline.assetIssuer,
      amount: "1",
      mode: "strict-send" as const,
    };

    await buildPathPaymentTransaction(params);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("self-payments"));
    const rejected = await buildPathPaymentTransaction({ ...params, selfPaymentBehavior: "error" });
    expect(rejected.status).toBe("error");
    warning.mockRestore();
  });
});

describe("issue #832 deterministic contract data keys", () => {
  it("serializes reordered nested fields identically", () => {
    const left = { b: 2, a: { y: true, x: 1 }, list: [{ d: 4, c: 3 }] };
    const right = { list: [{ c: 3, d: 4 }], a: { x: 1, y: true }, b: 2 };
    expect(serializeContractDataKey(left)).toBe(serializeContractDataKey(right));
    expect(equalContractDataKeys(left, right)).toBe(true);
  });
});

describe("issue #833 stream emitter backpressure", () => {
  it("waits for an async listener before delivering the next event", async () => {
    type Events = { data: number };
    const emitter = new StreamEventEmitter<Events>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const seen: number[] = [];
    emitter.on("data", async (value) => {
      seen.push(value);
      if (value === 1) await gate;
    });

    const first = emitter.emit("data", 1);
    const second = emitter.emit("data", 2);
    await Promise.resolve();
    expect(seen).toEqual([1]);
    release();
    await Promise.all([first, second]);
    expect(seen).toEqual([1, 2]);
  });
});

describe("issue #834 redundant trustline protection", () => {
  beforeEach(() => {
    validateTrustlineMock.mockReset();
    buildTrustlineTransactionMock.mockReset();
  });

  it("queries existence, skips existing lines, and caches the result", async () => {
    validateTrustlineMock.mockResolvedValue(ok({
      assetCode: trustline.assetCode,
      assetIssuer: trustline.assetIssuer,
      exists: true,
      balance: "1",
      limit: "10",
    }));
    const manager = new TrustlineManager(NETWORK_CONFIG.horizonUrl, NETWORK_CONFIG);
    const first = await manager.createTrustline(VALID_KEY, trustline);
    const second = await manager.createTrustline(VALID_KEY, trustline);

    expect(first).toEqual(expect.objectContaining({ status: "ok" }));
    if (first.status === "ok") expect(first.data).toEqual(expect.objectContaining({ xdr: null, skipped: true }));
    expect(second).toEqual(expect.objectContaining({ status: "ok" }));
    expect(validateTrustlineMock).toHaveBeenCalledTimes(1);
    expect(buildTrustlineTransactionMock).not.toHaveBeenCalled();
  });
});
