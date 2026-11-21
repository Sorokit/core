import { describe, expect, it } from "vitest";
import { Asset, Keypair, Networks, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { createPresets, presets, type PresetContext } from "./presets";
import { SorokitErrorCode } from "../shared/response";
import type { ComposeBuilder } from "./compose";

const SOURCE = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const USDC = { assetCode: "USDC", assetIssuer: ISSUER };
// sequenceNumber makes build() fully offline.
const ctx: PresetContext = { source: SOURCE, network: "testnet", options: { sequenceNumber: "100" } };
const p = createPresets(ctx);

function builder(r: ReturnType<typeof p.simplePayment>): ComposeBuilder {
  if (r.status !== "ok") throw new Error(r.error.message);
  return r.data;
}

async function build(b: ComposeBuilder): Promise<Transaction> {
  const r = await b.build();
  if (r.status !== "ok") throw new Error(r.error.message);
  return TransactionBuilder.fromXDR(r.data, Networks.TESTNET) as Transaction;
}

function validationMessage(r: { status: string; error: { code: string; message: string } | null }): string {
  expect(r.status).toBe("error");
  expect(r.error?.code).toBe(SorokitErrorCode.VALIDATION);
  return r.error?.message ?? "";
}

describe("presets.simplePayment", () => {
  it("builds a native payment by default", async () => {
    const tx = await build(builder(p.simplePayment(DEST, "10.5")));
    expect(tx.source).toBe(SOURCE);
    expect(tx.operations).toHaveLength(1);
    expect(tx.operations[0]).toMatchObject({ type: "payment", destination: DEST, amount: "10.5000000" });
    expect((tx.operations[0] as { asset: Asset }).asset.isNative()).toBe(true);
  });

  it("accepts an issued asset as an object or Asset instance", async () => {
    const a = await build(builder(p.simplePayment(DEST, "1", USDC)));
    const b = await build(builder(p.simplePayment(DEST, "1", new Asset("USDC", ISSUER))));
    for (const tx of [a, b]) {
      const asset = (tx.operations[0] as { asset: Asset }).asset;
      expect(asset.getCode()).toBe("USDC");
      expect(asset.getIssuer()).toBe(ISSUER);
    }
  });

  it("accepts muxed destinations", () => {
    const muxed = "MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAACJUQ";
    expect(p.simplePayment(muxed, "1").status).toBe("ok");
  });

  it("validates destination, amount and asset", () => {
    expect(validationMessage(p.simplePayment("GBAD", "1"))).toContain("destination");
    expect(validationMessage(p.simplePayment(DEST, "0"))).toContain("greater than 0");
    expect(validationMessage(p.simplePayment(DEST, "-1"))).toContain("positive decimal");
    expect(validationMessage(p.simplePayment(DEST, "1.12345678"))).toContain("7 decimal");
    expect(validationMessage(p.simplePayment(DEST, "922337203686"))).toContain("maximum");
    expect(validationMessage(p.simplePayment(DEST, 5 as unknown as string))).toContain("amount");
    expect(validationMessage(p.simplePayment(DEST, "1", { assetCode: "USDC" }))).toContain("assetIssuer");
    expect(validationMessage(p.simplePayment(DEST, "1", { assetCode: "TOOLONGASSETCODE", assetIssuer: ISSUER }))).toContain("asset");
    expect(validationMessage(p.simplePayment(DEST, "1", 7 as unknown as string))).toContain("asset");
  });
});

describe("presets.swapAssets", () => {
  it("builds a manage-sell-offer", async () => {
    const tx = await build(builder(p.swapAssets("native", USDC, "0.25", "100")));
    expect(tx.operations[0]).toMatchObject({ type: "manageSellOffer", amount: "100.0000000", price: "0.25", offerId: "0" });
    const op = tx.operations[0] as { selling: Asset; buying: Asset };
    expect(op.selling.isNative()).toBe(true);
    expect(op.buying.getCode()).toBe("USDC");
  });

  it("accepts a rational price", async () => {
    const tx = await build(builder(p.swapAssets(USDC, "XLM", { n: 4, d: 1 }, "5")));
    expect(tx.operations[0]).toMatchObject({ price: "4" });
  });

  it("validates assets, price and amount", () => {
    expect(validationMessage(p.swapAssets("native", "XLM", "1", "1"))).toContain("different assets");
    expect(validationMessage(p.swapAssets("native", USDC, "0", "1"))).toContain("price");
    expect(validationMessage(p.swapAssets("native", USDC, "abc", "1"))).toContain("price");
    expect(validationMessage(p.swapAssets("native", USDC, { n: 1, d: 0 }, "1"))).toContain("price");
    expect(validationMessage(p.swapAssets("native", USDC, "1", "0"))).toContain("amount");
  });
});

describe("presets.setupTrustline", () => {
  it("builds a change-trust with the maximum limit by default", async () => {
    const tx = await build(builder(p.setupTrustline(USDC)));
    expect(tx.operations[0]).toMatchObject({ type: "changeTrust", limit: "922337203685.4775807" });
  });

  it("applies an explicit limit", async () => {
    const tx = await build(builder(p.setupTrustline(USDC, "5000")));
    expect(tx.operations[0]).toMatchObject({ type: "changeTrust", limit: "5000.0000000" });
  });

  it("rejects native assets, self-issued assets and a zero limit", () => {
    expect(validationMessage(p.setupTrustline("native"))).toContain("does not need a trustline");
    expect(validationMessage(p.setupTrustline({ assetCode: "OWN", assetIssuer: SOURCE }))).toContain("its own asset");
    expect(validationMessage(p.setupTrustline(USDC, "0"))).toContain("limit must be greater than 0");
  });
});

describe("customisation after creation", () => {
  it("returns a builder that accepts more operations, memo and timeout", async () => {
    const b = builder(p.setupTrustline(USDC))
      .addPayment({ destination: DEST, amount: "1", asset: USDC })
      .addMemo("onboarding")
      .setTimeout(120);
    const tx = await build(b);
    expect(tx.operations.map((o) => o.type)).toEqual(["changeTrust", "payment"]);
    expect(tx.memo.value?.toString()).toBe("onboarding");
    expect(Number(tx.timeBounds?.maxTime)).toBeGreaterThan(0);
  });

  it("each call returns an independent builder", () => {
    const one = builder(p.simplePayment(DEST, "1"));
    const two = builder(p.simplePayment(DEST, "2"));
    one.addPayment({ destination: DEST, amount: "3" });
    expect(one.count()).toBe(2);
    expect(two.count()).toBe(1);
  });

  it("passes context options through to compose", async () => {
    const custom = createPresets({ ...ctx, options: { sequenceNumber: "41", estimatedFee: "500" } });
    const tx = await build(builder(custom.simplePayment(DEST, "1")));
    expect(tx.sequence).toBe("42");
    expect(tx.fee).toBe("500");
  });
});

describe("unbound presets and context validation", () => {
  it("take the context as the last argument", async () => {
    const tx = await build(builder(presets.simplePayment(DEST, "1", "native", ctx)));
    expect(tx.operations[0]).toMatchObject({ type: "payment" });
    expect(presets.swapAssets("native", USDC, "1", "1", ctx).status).toBe("ok");
    expect(presets.setupTrustline(USDC, undefined, ctx).status).toBe("ok");
  });

  it("reject a missing or invalid context", () => {
    expect(validationMessage(presets.simplePayment(DEST, "1", "native", undefined as unknown as PresetContext))).toContain("PresetContext");
    expect(validationMessage(createPresets({ source: "nope", network: "testnet" }).simplePayment(DEST, "1"))).toContain("context.source");
    expect(validationMessage(createPresets({ source: SOURCE, network: undefined as never }).simplePayment(DEST, "1"))).toContain("context.network");
  });
});
