/**
 * Tests for PaymentBuilder (issue #932):
 * - Muxed address support
 * - Path payment support
 * - Input validation
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Keypair, StrKey, Asset } from "@stellar/stellar-sdk";
import { buildPayment } from "./builders";
import type { FluentBuilderContext } from "./builders";
import { NETWORK_DEFAULTS } from "../network/config";

// ─── Test fixtures ────────────────────────────────────────────────────────────

const SOURCE_KEY = Keypair.random().publicKey();
const DEST_KEY = Keypair.random().publicKey();

// Generate a valid muxed address
function createMuxedAddress(baseKey: string, id: bigint = 123n): string {
  const decoded = StrKey.decodeEd25519PublicKey(baseKey);
  return StrKey.encodeMed25519PublicKey(decoded, id);
}

const MUXED_DEST = createMuxedAddress(DEST_KEY, 456n);

const ISSUER_KEY = Keypair.random().publicKey();

function createContext(overrides?: Partial<FluentBuilderContext>): FluentBuilderContext {
  return {
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkConfig: NETWORK_DEFAULTS.testnet,
    sourcePublicKey: SOURCE_KEY,
    sequenceNumber: "12345",
    estimatedFee: "100",
    timeoutSeconds: 30,
    ...overrides,
  };
}

// ─── Simple payment tests ────────────────────────────────────────────────────

describe("PaymentBuilder - Simple payments", () => {
  let context: FluentBuilderContext;

  beforeEach(() => {
    context = createContext();
  });

  it("builds a native XLM payment", async () => {
    const result = await buildPayment(context)
      .destination(DEST_KEY)
      .amount("100")
      .build();

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const tx = result.data;
      expect(tx.operations).toHaveLength(1);
      const op = tx.operations[0];
      expect(op.type).toBe("payment");
      if (op.type === "payment") {
        expect(op.destination).toBe(DEST_KEY);
        expect(op.amount).toBe("100");
        expect(op.asset.isNative()).toBe(true);
      }
    }
  });

  it("builds a custom asset payment", async () => {
    const result = await buildPayment(context)
      .destination(DEST_KEY)
      .amount("50.5")
      .asset("USDC", ISSUER_KEY)
      .build();

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const tx = result.data;
      expect(tx.operations).toHaveLength(1);
      const op = tx.operations[0];
      expect(op.type).toBe("payment");
      if (op.type === "payment") {
        expect(op.destination).toBe(DEST_KEY);
        expect(op.amount).toBe("50.5");
        expect(op.asset.isNative()).toBe(false);
        expect(op.asset.code).toBe("USDC");
        expect(op.asset.issuer).toBe(ISSUER_KEY);
      }
    }
  });

  it("accepts Asset instance", async () => {
    const asset = new Asset("EURC", ISSUER_KEY);
    const result = await buildPayment(context)
      .destination(DEST_KEY)
      .amount("25")
      .asset(asset)
      .build();

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const tx = result.data;
      const op = tx.operations[0];
      if (op.type === "payment") {
        expect(op.asset.code).toBe("EURC");
        expect(op.asset.issuer).toBe(ISSUER_KEY);
      }
    }
  });

  it("defaults to native asset when asset() not called", async () => {
    const result = await buildPayment(context)
      .destination(DEST_KEY)
      .amount("10")
      .build();

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const op = result.data.operations[0];
      if (op.type === "payment") {
        expect(op.asset.isNative()).toBe(true);
      }
    }
  });

  it("rejects missing destination", async () => {
    const result = await buildPayment(context)
      .amount("100")
      .build();

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("destination is required");
    }
  });

  it("rejects missing amount", async () => {
    const result = await buildPayment(context)
      .destination(DEST_KEY)
      .build();

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("amount is required");
    }
  });

  it("rejects invalid amount format", async () => {
    const result = await buildPayment(context)
      .destination(DEST_KEY)
      .amount("-10")
      .build();

    expect(result.status).toBe("error");
  });

  it("rejects invalid destination address", async () => {
    const result = await buildPayment(context)
      .destination("invalid-address")
      .amount("100")
      .build();

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe("INVALID_ADDRESS");
    }
  });

  it("accepts numeric amount", async () => {
    const result = await buildPayment(context)
      .destination(DEST_KEY)
      .amount(100.5)
      .build();

    expect(result.status).toBe("ok");
  });
});

// ─── Muxed address tests ─────────────────────────────────────────────────────

describe("PaymentBuilder - Muxed addresses (#932)", () => {
  let context: FluentBuilderContext;

  beforeEach(() => {
    context = createContext();
  });

  it("accepts muxed destination address", async () => {
    const result = await buildPayment(context)
      .destination(MUXED_DEST)
      .amount("100")
      .build();

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const op = result.data.operations[0];
      if (op.type === "payment") {
        expect(op.destination).toBe(MUXED_DEST);
      }
    }
  });

  it("accepts muxed address with custom asset", async () => {
    const result = await buildPayment(context)
      .destination(MUXED_DEST)
      .amount("50")
      .asset("USDC", ISSUER_KEY)
      .build();

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const op = result.data.operations[0];
      if (op.type === "payment") {
        expect(op.destination).toBe(MUXED_DEST);
        expect(op.asset.code).toBe("USDC");
      }
    }
  });

  it("accepts multiple different muxed addresses derived from same base", async () => {
    const muxed1 = createMuxedAddress(DEST_KEY, 100n);
    const muxed2 = createMuxedAddress(DEST_KEY, 200n);

    const result1 = await buildPayment(context)
      .destination(muxed1)
      .amount("10")
      .build();

    const result2 = await buildPayment(context)
      .destination(muxed2)
      .amount("20")
      .build();

    expect(result1.status).toBe("ok");
    expect(result2.status).toBe("ok");
    if (result1.status === "ok" && result2.status === "ok") {
      const op1 = result1.data.operations[0];
      const op2 = result2.data.operations[0];
      if (op1.type === "payment" && op2.type === "payment") {
        expect(op1.destination).toBe(muxed1);
        expect(op2.destination).toBe(muxed2);
        expect(op1.destination).not.toBe(op2.destination);
      }
    }
  });

  it("rejects invalid muxed address format", async () => {
    const result = await buildPayment(context)
      .destination("M" + "A".repeat(68)) // Invalid muxed address
      .amount("100")
      .build();

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe("INVALID_ADDRESS");
    }
  });
});

// ─── Path payment tests ──────────────────────────────────────────────────────

describe("PaymentBuilder - Path payments (#932)", () => {
  let context: FluentBuilderContext;

  beforeEach(() => {
    context = createContext();
  });

  it("builds strict-send path payment with intermediate assets", async () => {
    const result = await buildPayment(context)
      .destination(DEST_KEY)
      .sendAmount("100")
      .sendAsset("USDC", ISSUER_KEY)
      .destAsset("EURC", ISSUER_KEY)
      .path("XLM")
      .build();

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const op = result.data.operations[0];
      expect(op.type).toBe("pathPaymentStrictSend");
      if (op.type === "pathPaymentStrictSend") {
        expect(op.destination).toBe(DEST_KEY);
        expect(op.sendAmount).toBe("100");
        expect(op.sendAsset.code).toBe("USDC");
        expect(op.destAsset.code).toBe("EURC");
        expect(op.path).toHaveLength(1);
        expect(op.path[0].isNative()).toBe(true);
      }
    }
  });

  it("builds strict-receive path payment", async () => {
    const result = await buildPayment(context)
      .destination(DEST_KEY)
      .destAmount("50")
      .sendAsset("USDC", ISSUER_KEY)
      .destAsset("EURC", ISSUER_KEY)
      .path(["XLM", undefined])
      .build();

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const op = result.data.operations[0];
      expect(op.type).toBe("pathPaymentStrictReceive");
      if (op.type === "pathPaymentStrictReceive") {
        expect(op.destination).toBe(DEST_KEY);
        expect(op.destAmount).toBe("50");
        expect(op.sendAsset.code).toBe("USDC");
        expect(op.destAsset.code).toBe("EURC");
      }
    }
  });

  it("builds path payment with multiple intermediate assets", async () => {
    const issuer2 = Keypair.random().publicKey();
    const result = await buildPayment(context)
      .destination(DEST_KEY)
      .sendAmount("100")
      .sendAsset("USDC", ISSUER_KEY)
      .destAsset("BTC", issuer2)
      .path(
        "XLM",
        ["EURC", ISSUER_KEY],
        ["ETH", issuer2]
      )
      .build();

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const op = result.data.operations[0];
      if (op.type === "pathPaymentStrictSend") {
        expect(op.path).toHaveLength(3);
        expect(op.path[0].isNative()).toBe(true);
        expect(op.path[1].code).toBe("EURC");
        expect(op.path[2].code).toBe("ETH");
      }
    }
  });

  it("accepts Asset instances in path", async () => {
    const eurAsset = new Asset("EURC", ISSUER_KEY);
    const result = await buildPayment(context)
      .destination(DEST_KEY)
      .sendAmount("100")
      .sendAsset("USDC", ISSUER_KEY)
      .destAsset("BTC", ISSUER_KEY)
      .path(Asset.native(), eurAsset)
      .build();

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const op = result.data.operations[0];
      if (op.type === "pathPaymentStrictSend") {
        expect(op.path).toHaveLength(2);
        expect(op.path[0].isNative()).toBe(true);
        expect(op.path[1].code).toBe("EURC");
      }
    }
  });

  it("defaults send and dest assets to native XLM when not specified", async () => {
    const result = await buildPayment(context)
      .destination(DEST_KEY)
      .sendAmount("100")
      .build();

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const op = result.data.operations[0];
      if (op.type === "pathPaymentStrictSend") {
        expect(op.sendAsset.isNative()).toBe(true);
        expect(op.destAsset.isNative()).toBe(true);
      }
    }
  });

  it("accepts path payment to muxed address", async () => {
    const result = await buildPayment(context)
      .destination(MUXED_DEST)
      .sendAmount("100")
      .sendAsset("USDC", ISSUER_KEY)
      .destAsset("EURC", ISSUER_KEY)
      .path("XLM")
      .build();

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const op = result.data.operations[0];
      if (op.type === "pathPaymentStrictSend") {
        expect(op.destination).toBe(MUXED_DEST);
      }
    }
  });

  it("rejects both sendAmount and destAmount specified", async () => {
    const result = await buildPayment(context)
      .destination(DEST_KEY)
      .sendAmount("100")
      .destAmount("50")
      .build();

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("Cannot specify both sendAmount and destAmount");
    }
  });

  it("rejects empty path array", async () => {
    const result = await buildPayment(context)
      .destination(DEST_KEY)
      .sendAmount("100")
      .path()
      .build();

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("at least one intermediate asset");
    }
  });

  it("rejects path with more than 5 assets", async () => {
    const result = await buildPayment(context)
      .destination(DEST_KEY)
      .sendAmount("100")
      .path(
        ["A", ISSUER_KEY],
        ["B", ISSUER_KEY],
        ["C", ISSUER_KEY],
        ["D", ISSUER_KEY],
        ["E", ISSUER_KEY],
        ["F", ISSUER_KEY] // 6th asset
      )
      .build();

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("cannot contain more than 5");
    }
  });

  it("rejects invalid path asset", async () => {
    const result = await buildPayment(context)
      .destination(DEST_KEY)
      .sendAmount("100")
      .path(["TOOLONGASSETCODE", ISSUER_KEY])
      .build();

    expect(result.status).toBe("error");
  });
});

// ─── Edge cases and validation ───────────────────────────────────────────────

describe("PaymentBuilder - Edge cases", () => {
  let context: FluentBuilderContext;

  beforeEach(() => {
    context = createContext();
  });

  it("builds transaction with custom fee", async () => {
    const customContext = createContext({ estimatedFee: "500" });
    const result = await buildPayment(customContext)
      .destination(DEST_KEY)
      .amount("100")
      .build();

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.fee).toBe("500");
    }
  });

  it("builds transaction with custom timeout", async () => {
    const customContext = createContext({ timeoutSeconds: 60 });
    const result = await buildPayment(customContext)
      .destination(DEST_KEY)
      .amount("100")
      .build();

    expect(result.status).toBe("ok");
    // Timeout is set on transaction
  });

  it("handles decimal amounts correctly", async () => {
    const result = await buildPayment(context)
      .destination(DEST_KEY)
      .amount("0.0000001")
      .build();

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const op = result.data.operations[0];
      if (op.type === "payment") {
        expect(op.amount).toBe("0.0000001");
      }
    }
  });

  it("handles large amounts correctly", async () => {
    const result = await buildPayment(context)
      .destination(DEST_KEY)
      .amount("922337203685.4775807")
      .build();

    expect(result.status).toBe("ok");
  });

  it("chainable methods return builder for fluent API", () => {
    const builder = buildPayment(context);
    expect(builder.destination(DEST_KEY)).toBe(builder);
    expect(builder.amount("100")).toBe(builder);
    expect(builder.asset("USDC", ISSUER_KEY)).toBe(builder);
  });
});
