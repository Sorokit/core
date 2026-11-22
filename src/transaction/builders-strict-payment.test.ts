/**
 * Tests for strict payment builders (issue #934):
 * - PaymentStrictSendBuilder
 * - PaymentStrictReceiveBuilder
 * - Path payment support
 * - Slippage handling
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Keypair, Asset } from "@stellar/stellar-sdk";
import { buildPaymentStrictSend, buildPaymentStrictReceive } from "./builders";
import type { FluentBuilderContext } from "./builders";
import { NETWORK_DEFAULTS } from "../network/config";

// ─── Test fixtures ────────────────────────────────────────────────────────────

const SOURCE_KEY = Keypair.random().publicKey();
const DEST_KEY = Keypair.random().publicKey();
const ISSUER_KEY = Keypair.random().publicKey();
const ISSUER_KEY_2 = Keypair.random().publicKey();

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

// ─── PaymentStrictSendBuilder tests ───────────────────────────────────────────

describe("PaymentStrictSendBuilder - Basic functionality", () => {
  let context: FluentBuilderContext;

  beforeEach(() => {
    context = createContext();
  });

  it("builds strict-send payment with same asset (no path)", async () => {
    const result = await buildPaymentStrictSend(context)
      .destination(DEST_KEY)
      .sendAmount("100")
      .build();

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const op = result.data.operations[0];
      expect(op.type).toBe("pathPaymentStrictSend");
      if (op.type === "pathPaymentStrictSend") {
        expect(op.destination).toBe(DEST_KEY);
        expect(op.sendAmount).toBe("100");
        expect(op.sendAsset.isNative()).toBe(true);
        expect(op.destAsset.isNative()).toBe(true);
        expect(op.path).toEqual([]);
      }
    }
  });

  it("builds strict-send payment with different assets", async () => {
    const result = await buildPaymentStrictSend(context)
      .destination(DEST_KEY)
      .sendAmount("100")
      .sendAsset("USDC", ISSUER_KEY)
      .destAsset("EURC", ISSUER_KEY_2)
      .minDestAmount("95")
      .path("XLM")
      .build();

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const op = result.data.operations[0];
      if (op.type === "pathPaymentStrictSend") {
        expect(op.sendAmount).toBe("100");
        expect(op.sendAsset.code).toBe("USDC");
        expect(op.destAsset.code).toBe("EURC");
        expect(op.destMin).toBe("95");
        expect(op.path).toHaveLength(1);
        expect(op.path[0].isNative()).toBe(true);
      }
    }
  });

  it("uses default minimal destMin when not specified", async () => {
    const result = await buildPaymentStrictSend(context)
      .destination(DEST_KEY)
      .sendAmount("100")
      .build();

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const op = result.data.operations[0];
      if (op.type === "pathPaymentStrictSend") {
        expect(op.destMin).toBe("0.0000001");
      }
    }
  });

  it("accepts numeric send amount", async () => {
    const result = await buildPaymentStrictSend(context)
      .destination(DEST_KEY)
      .sendAmount(100.5)
      .build();

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const op = result.data.operations[0];
      if (op.type === "pathPaymentStrictSend") {
        expect(op.sendAmount).toBe("100.5");
      }
    }
  });

  it("accepts Asset instances", async () => {
    const sendAsset = new Asset("USDC", ISSUER_KEY);
    const destAsset = new Asset("EURC", ISSUER_KEY_2);

    const result = await buildPaymentStrictSend(context)
      .destination(DEST_KEY)
      .sendAmount("100")
      .sendAsset(sendAsset)
      .destAsset(destAsset)
      .path(Asset.native())
      .build();

    expect(result.status).toBe("ok");
  });
});

describe("PaymentStrictSendBuilder - Path payments", () => {
  let context: FluentBuilderContext;

  beforeEach(() => {
    context = createContext();
  });

  it("builds path payment with single intermediate asset", async () => {
    const result = await buildPaymentStrictSend(context)
      .destination(DEST_KEY)
      .sendAmount("100")
      .sendAsset("USDC", ISSUER_KEY)
      .destAsset("EURC", ISSUER_KEY_2)
      .path("XLM")
      .build();

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const op = result.data.operations[0];
      if (op.type === "pathPaymentStrictSend") {
        expect(op.path).toHaveLength(1);
        expect(op.path[0].isNative()).toBe(true);
      }
    }
  });

  it("builds path payment with multiple intermediate assets", async () => {
    const issuer3 = Keypair.random().publicKey();
    const result = await buildPaymentStrictSend(context)
      .destination(DEST_KEY)
      .sendAmount("100")
      .sendAsset("USDC", ISSUER_KEY)
      .destAsset("BTC", issuer3)
      .path(
        "XLM",
        ["EURC", ISSUER_KEY_2],
        ["ETH", issuer3]
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

  it("rejects empty path", async () => {
    const result = await buildPaymentStrictSend(context)
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
    const result = await buildPaymentStrictSend(context)
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
});

describe("PaymentStrictSendBuilder - Slippage protection", () => {
  let context: FluentBuilderContext;

  beforeEach(() => {
    context = createContext();
  });

  it("sets minimum destination amount for slippage protection", async () => {
    const result = await buildPaymentStrictSend(context)
      .destination(DEST_KEY)
      .sendAmount("100")
      .minDestAmount("95") // 5% slippage tolerance
      .build();

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const op = result.data.operations[0];
      if (op.type === "pathPaymentStrictSend") {
        expect(op.destMin).toBe("95");
      }
    }
  });

  it("allows tight slippage protection", async () => {
    const result = await buildPaymentStrictSend(context)
      .destination(DEST_KEY)
      .sendAmount("100")
      .minDestAmount("99.5") // 0.5% slippage
      .build();

    expect(result.status).toBe("ok");
  });

  it("allows loose slippage protection", async () => {
    const result = await buildPaymentStrictSend(context)
      .destination(DEST_KEY)
      .sendAmount("100")
      .minDestAmount("50") // 50% slippage
      .build();

    expect(result.status).toBe("ok");
  });
});

describe("PaymentStrictSendBuilder - Validation", () => {
  let context: FluentBuilderContext;

  beforeEach(() => {
    context = createContext();
  });

  it("rejects missing destination", async () => {
    const result = await buildPaymentStrictSend(context)
      .sendAmount("100")
      .build();

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("Destination is required");
    }
  });

  it("rejects missing send amount", async () => {
    const result = await buildPaymentStrictSend(context)
      .destination(DEST_KEY)
      .build();

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("Send amount is required");
    }
  });

  it("rejects invalid destination address", async () => {
    const result = await buildPaymentStrictSend(context)
      .destination("invalid")
      .sendAmount("100")
      .build();

    expect(result.status).toBe("error");
  });

  it("rejects invalid send amount", async () => {
    const result = await buildPaymentStrictSend(context)
      .destination(DEST_KEY)
      .sendAmount("-100")
      .build();

    expect(result.status).toBe("error");
  });

  it("rejects invalid min dest amount", async () => {
    const result = await buildPaymentStrictSend(context)
      .destination(DEST_KEY)
      .sendAmount("100")
      .minDestAmount("-50")
      .build();

    expect(result.status).toBe("error");
  });
});

// ─── PaymentStrictReceiveBuilder tests ────────────────────────────────────────

describe("PaymentStrictReceiveBuilder - Basic functionality", () => {
  let context: FluentBuilderContext;

  beforeEach(() => {
    context = createContext();
  });

  it("builds strict-receive payment with same asset (no path)", async () => {
    const result = await buildPaymentStrictReceive(context)
      .destination(DEST_KEY)
      .destAmount("100")
      .build();

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const op = result.data.operations[0];
      expect(op.type).toBe("pathPaymentStrictReceive");
      if (op.type === "pathPaymentStrictReceive") {
        expect(op.destination).toBe(DEST_KEY);
        expect(op.destAmount).toBe("100");
        expect(op.sendAsset.isNative()).toBe(true);
        expect(op.destAsset.isNative()).toBe(true);
        expect(op.path).toEqual([]);
      }
    }
  });

  it("builds strict-receive payment with different assets", async () => {
    const result = await buildPaymentStrictReceive(context)
      .destination(DEST_KEY)
      .destAmount("100")
      .sendAsset("USDC", ISSUER_KEY)
      .destAsset("EURC", ISSUER_KEY_2)
      .maxSendAmount("110")
      .path("XLM")
      .build();

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const op = result.data.operations[0];
      if (op.type === "pathPaymentStrictReceive") {
        expect(op.destAmount).toBe("100");
        expect(op.sendAsset.code).toBe("USDC");
        expect(op.destAsset.code).toBe("EURC");
        expect(op.sendMax).toBe("110");
        expect(op.path).toHaveLength(1);
        expect(op.path[0].isNative()).toBe(true);
      }
    }
  });

  it("uses default maximal sendMax when not specified", async () => {
    const result = await buildPaymentStrictReceive(context)
      .destination(DEST_KEY)
      .destAmount("100")
      .build();

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const op = result.data.operations[0];
      if (op.type === "pathPaymentStrictReceive") {
        expect(op.sendMax).toBe("922337203685.4775807");
      }
    }
  });

  it("accepts numeric dest amount", async () => {
    const result = await buildPaymentStrictReceive(context)
      .destination(DEST_KEY)
      .destAmount(100.5)
      .build();

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const op = result.data.operations[0];
      if (op.type === "pathPaymentStrictReceive") {
        expect(op.destAmount).toBe("100.5");
      }
    }
  });

  it("accepts Asset instances", async () => {
    const sendAsset = new Asset("USDC", ISSUER_KEY);
    const destAsset = new Asset("EURC", ISSUER_KEY_2);

    const result = await buildPaymentStrictReceive(context)
      .destination(DEST_KEY)
      .destAmount("100")
      .sendAsset(sendAsset)
      .destAsset(destAsset)
      .path(Asset.native())
      .build();

    expect(result.status).toBe("ok");
  });
});

describe("PaymentStrictReceiveBuilder - Path payments", () => {
  let context: FluentBuilderContext;

  beforeEach(() => {
    context = createContext();
  });

  it("builds path payment with single intermediate asset", async () => {
    const result = await buildPaymentStrictReceive(context)
      .destination(DEST_KEY)
      .destAmount("100")
      .sendAsset("USDC", ISSUER_KEY)
      .destAsset("EURC", ISSUER_KEY_2)
      .path("XLM")
      .build();

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const op = result.data.operations[0];
      if (op.type === "pathPaymentStrictReceive") {
        expect(op.path).toHaveLength(1);
        expect(op.path[0].isNative()).toBe(true);
      }
    }
  });

  it("builds path payment with multiple intermediate assets", async () => {
    const issuer3 = Keypair.random().publicKey();
    const result = await buildPaymentStrictReceive(context)
      .destination(DEST_KEY)
      .destAmount("100")
      .sendAsset("USDC", ISSUER_KEY)
      .destAsset("BTC", issuer3)
      .path(
        "XLM",
        ["EURC", ISSUER_KEY_2],
        ["ETH", issuer3]
      )
      .build();

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const op = result.data.operations[0];
      if (op.type === "pathPaymentStrictReceive") {
        expect(op.path).toHaveLength(3);
      }
    }
  });
});

describe("PaymentStrictReceiveBuilder - Slippage protection", () => {
  let context: FluentBuilderContext;

  beforeEach(() => {
    context = createContext();
  });

  it("sets maximum send amount for slippage protection", async () => {
    const result = await buildPaymentStrictReceive(context)
      .destination(DEST_KEY)
      .destAmount("100")
      .maxSendAmount("105") // 5% slippage tolerance
      .build();

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const op = result.data.operations[0];
      if (op.type === "pathPaymentStrictReceive") {
        expect(op.sendMax).toBe("105");
      }
    }
  });

  it("allows tight slippage protection", async () => {
    const result = await buildPaymentStrictReceive(context)
      .destination(DEST_KEY)
      .destAmount("100")
      .maxSendAmount("100.5") // 0.5% slippage
      .build();

    expect(result.status).toBe("ok");
  });

  it("allows loose slippage protection", async () => {
    const result = await buildPaymentStrictReceive(context)
      .destination(DEST_KEY)
      .destAmount("100")
      .maxSendAmount("200") // 100% slippage
      .build();

    expect(result.status).toBe("ok");
  });
});

describe("PaymentStrictReceiveBuilder - Validation", () => {
  let context: FluentBuilderContext;

  beforeEach(() => {
    context = createContext();
  });

  it("rejects missing destination", async () => {
    const result = await buildPaymentStrictReceive(context)
      .destAmount("100")
      .build();

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("Destination is required");
    }
  });

  it("rejects missing dest amount", async () => {
    const result = await buildPaymentStrictReceive(context)
      .destination(DEST_KEY)
      .build();

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("Destination amount is required");
    }
  });

  it("rejects invalid max send amount", async () => {
    const result = await buildPaymentStrictReceive(context)
      .destination(DEST_KEY)
      .destAmount("100")
      .maxSendAmount("-110")
      .build();

    expect(result.status).toBe("error");
  });
});

// ─── Comparison between strict variants ───────────────────────────────────────

describe("Strict variants - Difference documentation", () => {
  let context: FluentBuilderContext;

  beforeEach(() => {
    context = createContext();
  });

  it("strict-send: sender controls exact outflow", async () => {
    // Use strict-send when you want to control exactly what you spend
    const strictSend = await buildPaymentStrictSend(context)
      .destination(DEST_KEY)
      .sendAmount("100") // I will send EXACTLY 100
      .minDestAmount("95") // Recipient gets at least 95
      .build();

    expect(strictSend.status).toBe("ok");
    if (strictSend.status === "ok") {
      const op = strictSend.data.operations[0];
      if (op.type === "pathPaymentStrictSend") {
        expect(op.sendAmount).toBe("100"); // Fixed send
        expect(op.destMin).toBe("95"); // Variable receive (minimum)
      }
    }
  });

  it("strict-receive: recipient controls exact inflow", async () => {
    // Use strict-receive when you want recipient to get an exact amount
    const strictReceive = await buildPaymentStrictReceive(context)
      .destination(DEST_KEY)
      .destAmount("100") // Recipient will get EXACTLY 100
      .maxSendAmount("105") // I'll pay at most 105
      .build();

    expect(strictReceive.status).toBe("ok");
    if (strictReceive.status === "ok") {
      const op = strictReceive.data.operations[0];
      if (op.type === "pathPaymentStrictReceive") {
        expect(op.destAmount).toBe("100"); // Fixed receive
        expect(op.sendMax).toBe("105"); // Variable send (maximum)
      }
    }
  });

  it("demonstrates use case: exact bill payment", async () => {
    // Paying a bill that must be exactly $100
    const billPayment = await buildPaymentStrictReceive(context)
      .destination(DEST_KEY)
      .destAmount("100") // Bill is exactly $100
      .sendAsset("USDC", ISSUER_KEY)
      .destAsset("USD", ISSUER_KEY_2)
      .maxSendAmount("102") // Willing to pay up to $102
      .build();

    expect(billPayment.status).toBe("ok");
  });

  it("demonstrates use case: spending exact budget", async () => {
    // Spending exactly $100 from budget
    const budgetSpend = await buildPaymentStrictSend(context)
      .destination(DEST_KEY)
      .sendAmount("100") // Budget is exactly $100
      .sendAsset("USDC", ISSUER_KEY)
      .destAsset("EUR", ISSUER_KEY_2)
      .minDestAmount("90") // Recipient gets at least €90
      .build();

    expect(budgetSpend.status).toBe("ok");
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe("Strict payment builders - Edge cases", () => {
  let context: FluentBuilderContext;

  beforeEach(() => {
    context = createContext();
  });

  it("chainable methods return builder", () => {
    const builder = buildPaymentStrictSend(context);
    expect(builder.destination(DEST_KEY)).toBe(builder);
    expect(builder.sendAmount("100")).toBe(builder);
    expect(builder.minDestAmount("95")).toBe(builder);
  });

  it("handles very small amounts", async () => {
    const result = await buildPaymentStrictSend(context)
      .destination(DEST_KEY)
      .sendAmount("0.0000001")
      .minDestAmount("0.00000001")
      .build();

    expect(result.status).toBe("ok");
  });

  it("handles very large amounts", async () => {
    const result = await buildPaymentStrictReceive(context)
      .destination(DEST_KEY)
      .destAmount("922337203685.4775807")
      .build();

    expect(result.status).toBe("ok");
  });
});
