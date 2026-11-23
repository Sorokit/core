import { describe, expect, it } from "vitest";
import {
  Asset,
  AuthRequiredFlag,
  AuthRevocableFlag,
  Keypair,
  Networks,
} from "@stellar/stellar-sdk";
import { SorokitErrorCode } from "../shared/response";
import type { ResolvedNetworkConfig } from "../shared/types";
import {
  buildManageOffer,
  buildSetOptions,
  ManageOfferBuilder,
  SetOptionsBuilder,
} from "./builders";
import {
  ManageOfferBuilder as ExportedManageOfferBuilder,
  SetOptionsBuilder as ExportedSetOptionsBuilder,
} from "./index";
import {
  ManageOfferBuilder as RootManageOfferBuilder,
  SetOptionsBuilder as RootSetOptionsBuilder,
} from "../index";

const networkConfig: ResolvedNetworkConfig = {
  network: "testnet",
  horizonUrl: "https://horizon-testnet.stellar.org",
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: Networks.TESTNET,
};

const source = Keypair.random().publicKey();
const signerA = Keypair.random().publicKey();
const signerB = Keypair.random().publicKey();
const issuer = Keypair.random().publicKey();
const context = {
  horizonUrl: networkConfig.horizonUrl,
  networkConfig,
  sourcePublicKey: source,
  sequenceNumber: "1",
};

describe("SetOptionsBuilder (#908)", () => {
  it("is exported from the transaction and root entry points", () => {
    expect(ExportedSetOptionsBuilder).toBe(SetOptionsBuilder);
    expect(RootSetOptionsBuilder).toBe(SetOptionsBuilder);
    expect(buildSetOptions(context)).toBeInstanceOf(SetOptionsBuilder);
  });

  it("supports weights, ordered thresholds, signers, flags and home domain", async () => {
    const result = await new SetOptionsBuilder(context)
      .masterWeight(1)
      .lowThreshold(1)
      .medThreshold(2)
      .highThreshold(3)
      .signer(signerA, 2)
      .signer(signerB, 1)
      .setFlags(AuthRequiredFlag)
      .clearFlags(AuthRevocableFlag)
      .homeDomain("example.com")
      .build();

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const operations = result.data.operations as Array<Record<string, unknown>>;
    expect(operations).toHaveLength(3);
    expect(operations[0]).toMatchObject({
      type: "setOptions",
      masterWeight: 1,
      lowThreshold: 1,
      medThreshold: 2,
      highThreshold: 3,
      homeDomain: "example.com",
      setFlags: AuthRequiredFlag,
      clearFlags: AuthRevocableFlag,
    });
    expect(operations[1]).toMatchObject({
      type: "setOptions",
      signer: { ed25519PublicKey: signerA, weight: 2 },
    });
    expect(operations[2]).toMatchObject({
      type: "setOptions",
      signer: { ed25519PublicKey: signerB, weight: 1 },
    });
  });

  it.each([
    ["masterWeight", -1],
    ["lowThreshold", 256],
    ["medThreshold", 1.5],
  ])("rejects an out-of-range %s", async (method, value) => {
    const builder = new SetOptionsBuilder(context);
    const result = await (builder as unknown as Record<string, (v: number) => SetOptionsBuilder>)[method]!(value).build();
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
    }
  });

  it.each([
    ["lowThreshold", "medThreshold"],
    ["medThreshold", "highThreshold"],
  ])("rejects %s greater than %s", async (lower, higher) => {
    const builder = new SetOptionsBuilder(context);
    (builder as unknown as Record<string, (v: number) => SetOptionsBuilder>)[lower]!(3);
    (builder as unknown as Record<string, (v: number) => SetOptionsBuilder>)[higher]!(1);
    const result = await builder.build();
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("must be less than or equal to");
    }
  });

  it("removes a signer with weight 0", async () => {
    const result = await new SetOptionsBuilder(context).removeSigner(signerA).build();
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.operations).toMatchObject([
      { signer: { ed25519PublicKey: signerA, weight: 0 } },
    ]);
  });

  it("rejects an invalid signer key", async () => {
    const result = await new SetOptionsBuilder(context).signer("not-a-key", 1).build();
    expect(result.status).toBe("error");
  });

  it("rejects an empty builder", async () => {
    const result = await new SetOptionsBuilder(context).build();
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("at least one option");
    }
  });
});

describe("ManageOfferBuilder (#905)", () => {
  it("is exported from the transaction and root entry points", () => {
    expect(ExportedManageOfferBuilder).toBe(ManageOfferBuilder);
    expect(RootManageOfferBuilder).toBe(ManageOfferBuilder);
    expect(buildManageOffer(context)).toBeInstanceOf(ManageOfferBuilder);
  });

  const usdc = new Asset("USDC", issuer);

  it("creates an offer with a string price", async () => {
    const result = await new ManageOfferBuilder(context)
      .sellingAsset(Asset.native())
      .buyingAsset(usdc)
      .amount("10")
      .price("1.25")
      .build();

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.operations).toMatchObject([
      {
        type: "manageSellOffer",
        selling: { code: "XLM" },
        buying: { code: "USDC", issuer },
        amount: "10.0000000",
        price: "1.25",
      },
    ]);
  });

  it("updates an existing offer with a numeric price", async () => {
    const result = await new ManageOfferBuilder(context)
      .sellingAsset("XLM")
      .buyingAsset("USDC", issuer)
      .amount("20")
      .price(2.5)
      .offerId(42)
      .build();

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.operations).toMatchObject([
      { type: "manageSellOffer", price: "2.5", offerId: "42" },
    ]);
  });

  it("cancels an offer when the amount is zero", async () => {
    const result = await new ManageOfferBuilder(context)
      .sellingAsset(Asset.native())
      .buyingAsset(usdc)
      .amount(0)
      .price("1")
      .offerId("7")
      .build();

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.operations).toMatchObject([
      { type: "manageSellOffer", amount: "0.0000000", offerId: "7" },
    ]);
  });

  it("rejects a non-native asset without an issuer", async () => {
    const result = await new ManageOfferBuilder(context)
      .sellingAsset("USDC")
      .buyingAsset("XLM")
      .amount("1")
      .price("1")
      .build();
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("sellingAsset");
    }
  });

  it.each(["0", "-1", "abc", "Infinity"])("rejects an invalid price %s", async (price) => {
    const result = await new ManageOfferBuilder(context)
      .sellingAsset(Asset.native())
      .buyingAsset(usdc)
      .amount("1")
      .price(price)
      .build();
    expect(result.status).toBe("error");
  });

  it("rejects a non-integer offer id", async () => {
    const result = await new ManageOfferBuilder(context)
      .sellingAsset(Asset.native())
      .buyingAsset(usdc)
      .amount("1")
      .price("1")
      .offerId("abc")
      .build();
    expect(result.status).toBe("error");
  });
});
