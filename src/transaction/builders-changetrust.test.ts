/**
 * Tests for ChangeTrustBuilder (issue #933):
 * - Create trustlines
 * - Update limits
 * - Remove trustlines
 * - Asset validation
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Keypair, Asset } from "@stellar/stellar-sdk";
import { buildChangeTrust } from "./builders";
import type { FluentBuilderContext } from "./builders";
import { NETWORK_DEFAULTS } from "../network/config";

// ─── Test fixtures ────────────────────────────────────────────────────────────

const SOURCE_KEY = Keypair.random().publicKey();
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

// ─── Create trustline tests ───────────────────────────────────────────────────

describe("ChangeTrustBuilder - Create trustlines", () => {
  let context: FluentBuilderContext;

  beforeEach(() => {
    context = createContext();
  });

  it("creates a trustline with default maximum limit", async () => {
    const result = await buildChangeTrust(context)
      .asset("USDC", ISSUER_KEY)
      .build();

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const tx = result.data;
      expect(tx.operations).toHaveLength(1);
      const op = tx.operations[0];
      expect(op.type).toBe("changeTrust");
      if (op.type === "changeTrust") {
        expect(op.line.code).toBe("USDC");
        expect(op.line.issuer).toBe(ISSUER_KEY);
        expect(op.limit).toBeUndefined(); // Default max limit
      }
    }
  });

  it("creates a trustline with custom limit", async () => {
    const result = await buildChangeTrust(context)
      .asset("EURC", ISSUER_KEY)
      .limit("1000")
      .build();

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const op = result.data.operations[0];
      if (op.type === "changeTrust") {
        expect(op.line.code).toBe("EURC");
        expect(op.limit).toBe("1000");
      }
    }
  });

  it("creates a trustline with numeric limit", async () => {
    const result = await buildChangeTrust(context)
      .asset("BTC", ISSUER_KEY)
      .limit(500.5)
      .build();

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const op = result.data.operations[0];
      if (op.type === "changeTrust") {
        expect(op.limit).toBe("500.5");
      }
    }
  });

  it("creates a trustline with decimal limit", async () => {
    const result = await buildChangeTrust(context)
      .asset("USDC", ISSUER_KEY)
      .limit("0.0000001")
      .build();

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const op = result.data.operations[0];
      if (op.type === "changeTrust") {
        expect(op.limit).toBe("0.0000001");
      }
    }
  });

  it("accepts Asset instance", async () => {
    const asset = new Asset("USDC", ISSUER_KEY);
    const result = await buildChangeTrust(context)
      .asset(asset)
      .build();

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const op = result.data.operations[0];
      if (op.type === "changeTrust") {
        expect(op.line.code).toBe("USDC");
        expect(op.line.issuer).toBe(ISSUER_KEY);
      }
    }
  });

  it("accepts asset code without calling limit()", async () => {
    const result = await buildChangeTrust(context)
      .asset("USDC", ISSUER_KEY)
      .build();

    expect(result.status).toBe("ok");
  });
});

// ─── Update trustline tests ───────────────────────────────────────────────────

describe("ChangeTrustBuilder - Update limits", () => {
  let context: FluentBuilderContext;

  beforeEach(() => {
    context = createContext();
  });

  it("updates trustline limit to new value", async () => {
    const result = await buildChangeTrust(context)
      .asset("USDC", ISSUER_KEY)
      .limit("5000")
      .build();

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const op = result.data.operations[0];
      if (op.type === "changeTrust") {
        expect(op.limit).toBe("5000");
      }
    }
  });

  it("updates limit to maximum by omitting limit()", async () => {
    const result = await buildChangeTrust(context)
      .asset("USDC", ISSUER_KEY)
      .build();

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const op = result.data.operations[0];
      if (op.type === "changeTrust") {
        expect(op.limit).toBeUndefined();
      }
    }
  });

  it("allows large limit values", async () => {
    const result = await buildChangeTrust(context)
      .asset("USDC", ISSUER_KEY)
      .limit("922337203685.4775807")
      .build();

    expect(result.status).toBe("ok");
  });
});

// ─── Remove trustline tests ───────────────────────────────────────────────────

describe("ChangeTrustBuilder - Remove trustlines", () => {
  let context: FluentBuilderContext;

  beforeEach(() => {
    context = createContext();
  });

  it("removes trustline with limit of 0", async () => {
    const result = await buildChangeTrust(context)
      .asset("USDC", ISSUER_KEY)
      .limit("0")
      .build();

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const op = result.data.operations[0];
      if (op.type === "changeTrust") {
        expect(op.limit).toBe("0");
      }
    }
  });

  it("removes trustline with numeric 0", async () => {
    const result = await buildChangeTrust(context)
      .asset("EURC", ISSUER_KEY)
      .limit(0)
      .build();

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const op = result.data.operations[0];
      if (op.type === "changeTrust") {
        expect(op.limit).toBe("0");
      }
    }
  });
});

// ─── Validation tests ─────────────────────────────────────────────────────────

describe("ChangeTrustBuilder - Validation", () => {
  let context: FluentBuilderContext;

  beforeEach(() => {
    context = createContext();
  });

  it("rejects missing asset", async () => {
    const result = await buildChangeTrust(context)
      .limit("1000")
      .build();

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("Asset is required");
    }
  });

  it("rejects native XLM asset", async () => {
    const result = await buildChangeTrust(context)
      .asset(Asset.native())
      .build();

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("Cannot create trustline for native XLM");
    }
  });

  it("rejects XLM as string asset code", async () => {
    const result = await buildChangeTrust(context)
      .asset("XLM", ISSUER_KEY)
      .build();

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("native");
    }
  });

  it("rejects negative limit", async () => {
    const result = await buildChangeTrust(context)
      .asset("USDC", ISSUER_KEY)
      .limit("-100")
      .build();

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("non-negative");
    }
  });

  it("rejects invalid limit format", async () => {
    const result = await buildChangeTrust(context)
      .asset("USDC", ISSUER_KEY)
      .limit("not-a-number")
      .build();

    expect(result.status).toBe("error");
  });

  it("rejects limit with too many decimals", async () => {
    const result = await buildChangeTrust(context)
      .asset("USDC", ISSUER_KEY)
      .limit("1.12345678") // 8 decimal places
      .build();

    expect(result.status).toBe("error");
  });

  it("rejects invalid asset code", async () => {
    const result = await buildChangeTrust(context)
      .asset("TOOLONGASSETCODE", ISSUER_KEY)
      .build();

    expect(result.status).toBe("error");
  });

  it("rejects invalid issuer address", async () => {
    const result = await buildChangeTrust(context)
      .asset("USDC", "invalid-issuer")
      .build();

    expect(result.status).toBe("error");
  });

  it("rejects asset without issuer", async () => {
    const result = await buildChangeTrust(context)
      .asset("USDC")
      .build();

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("issuer");
    }
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe("ChangeTrustBuilder - Edge cases", () => {
  let context: FluentBuilderContext;

  beforeEach(() => {
    context = createContext();
  });

  it("handles 4-character asset codes", async () => {
    const result = await buildChangeTrust(context)
      .asset("USDC", ISSUER_KEY)
      .build();

    expect(result.status).toBe("ok");
  });

  it("handles 12-character asset codes", async () => {
    const result = await buildChangeTrust(context)
      .asset("LONGASSET123", ISSUER_KEY)
      .build();

    expect(result.status).toBe("ok");
  });

  it("handles 1-character asset codes", async () => {
    const result = await buildChangeTrust(context)
      .asset("X", ISSUER_KEY)
      .build();

    expect(result.status).toBe("ok");
  });

  it("builds transaction with custom fee", async () => {
    const customContext = createContext({ estimatedFee: "500" });
    const result = await buildChangeTrust(customContext)
      .asset("USDC", ISSUER_KEY)
      .build();

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.fee).toBe("500");
    }
  });

  it("builds transaction with custom timeout", async () => {
    const customContext = createContext({ timeoutSeconds: 60 });
    const result = await buildChangeTrust(customContext)
      .asset("USDC", ISSUER_KEY)
      .build();

    expect(result.status).toBe("ok");
  });

  it("chainable methods return builder for fluent API", () => {
    const builder = buildChangeTrust(context);
    expect(builder.asset("USDC", ISSUER_KEY)).toBe(builder);
    expect(builder.limit("1000")).toBe(builder);
  });

  it("handles calling limit() multiple times (last wins)", async () => {
    const result = await buildChangeTrust(context)
      .asset("USDC", ISSUER_KEY)
      .limit("1000")
      .limit("2000")
      .build();

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const op = result.data.operations[0];
      if (op.type === "changeTrust") {
        expect(op.limit).toBe("2000");
      }
    }
  });

  it("handles calling asset() multiple times (last wins)", async () => {
    const issuer2 = Keypair.random().publicKey();
    const result = await buildChangeTrust(context)
      .asset("USDC", ISSUER_KEY)
      .asset("EURC", issuer2)
      .build();

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const op = result.data.operations[0];
      if (op.type === "changeTrust") {
        expect(op.line.code).toBe("EURC");
        expect(op.line.issuer).toBe(issuer2);
      }
    }
  });
});

// ─── Real-world scenarios ─────────────────────────────────────────────────────

describe("ChangeTrustBuilder - Real-world scenarios", () => {
  let context: FluentBuilderContext;

  beforeEach(() => {
    context = createContext();
  });

  it("creates USDC trustline (common testnet asset)", async () => {
    const USDC_TESTNET = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
    const result = await buildChangeTrust(context)
      .asset("USDC", USDC_TESTNET)
      .build();

    expect(result.status).toBe("ok");
  });

  it("creates trustline with conservative limit for initial trust", async () => {
    const result = await buildChangeTrust(context)
      .asset("USDC", ISSUER_KEY)
      .limit("100")
      .build();

    expect(result.status).toBe("ok");
  });

  it("removes trustline after asset no longer needed", async () => {
    const result = await buildChangeTrust(context)
      .asset("USDC", ISSUER_KEY)
      .limit("0")
      .build();

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const op = result.data.operations[0];
      if (op.type === "changeTrust") {
        expect(op.limit).toBe("0");
      }
    }
  });

  it("creates trustline for stablecoin with high limit", async () => {
    const result = await buildChangeTrust(context)
      .asset("USDC", ISSUER_KEY)
      .limit("1000000")
      .build();

    expect(result.status).toBe("ok");
  });

  it("creates multiple trustlines sequentially (separate transactions)", async () => {
    const assets = [
      ["USDC", ISSUER_KEY],
      ["EURC", ISSUER_KEY],
      ["BTC", ISSUER_KEY],
    ] as const;

    const results = await Promise.all(
      assets.map(([code, issuer]) =>
        buildChangeTrust(context)
          .asset(code, issuer)
          .build()
      )
    );

    expect(results.every(r => r.status === "ok")).toBe(true);
  });
});
