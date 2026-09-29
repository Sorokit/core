import { Account, Asset, Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { buildAtomicSwap } from "./atomicSwap";

const traderKey = Keypair.random();
const issuer = Keypair.random().publicKey();
const trader = {
  account: new Account(traderKey.publicKey(), "123"),
  networkPassphrase: Networks.TESTNET,
};
const selling = Asset.native();
const buying = new Asset("EURC", issuer);

function priceFeed(
  sellingPrice = 1,
  buyingPrice = 0.5,
  priceImpactPercent = 0,
) {
  return {
    getPrice: async (asset: string) => ({
      asset,
      price: asset === "XLM" ? sellingPrice : buyingPrice,
      priceImpactPercent,
      currency: "USD",
      provider: "test",
      timestamp: new Date().toISOString(),
      status: "fresh" as const,
    }),
  };
}

function operationMinimum(xdr: string): string {
  const transaction = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
  const operation = transaction.operations[0];
  if (operation.type !== "pathPaymentStrictSend") {
    throw new Error("Expected a strict-send path payment operation.");
  }
  return operation.destMin;
}

describe("buildAtomicSwap", () => {
  it("builds a strict-send transaction with the slippage floor on-chain", async () => {
    const result = await buildAtomicSwap(trader, {
      selling,
      amount: "100",
      buying,
      maxSlippage: 1,
      priceFeed: priceFeed(),
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(operationMinimum(result.data)).toBe("198.0000000");
    }
  });

  it("uses zero slippage for the full feed-derived expected output", async () => {
    const result = await buildAtomicSwap(trader, {
      selling,
      amount: "100",
      buying,
      maxSlippage: 0,
      priceFeed: priceFeed(2, 0.5),
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(operationMinimum(result.data)).toBe("400.0000000");
    }
  });

  it("adjusts the expected output and floor when feed prices change", async () => {
    const previous = await buildAtomicSwap(trader, {
      selling,
      amount: "10",
      buying,
      maxSlippage: 2,
      priceFeed: priceFeed(1, 1),
    });
    const updated = await buildAtomicSwap(trader, {
      selling,
      amount: "10",
      buying,
      maxSlippage: 2,
      priceFeed: priceFeed(2, 1),
    });

    expect(previous.status).toBe("ok");
    expect(updated.status).toBe("ok");
    if (previous.status === "ok" && updated.status === "ok") {
      expect(operationMinimum(previous.data)).toBe("9.8000000");
      expect(operationMinimum(updated.data)).toBe("19.6000000");
    }
  });

  it("applies the feed price impact estimate before the slippage floor", async () => {
    const result = await buildAtomicSwap(trader, {
      selling,
      amount: "100",
      buying,
      maxSlippage: 1,
      priceFeed: priceFeed(1, 0.5, 2),
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(operationMinimum(result.data)).toBe("194.0400000");
    }
  });

  it.each([-0.1, 50.1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid maxSlippage %s",
    async (maxSlippage) => {
      const result = await buildAtomicSwap(trader, {
        selling,
        amount: "10",
        buying,
        maxSlippage,
        priceFeed: priceFeed(),
      });

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe("VALIDATION");
      }
    },
  );

  it.each(["0", "-1", "1.00000000", "not-a-number"])(
    "rejects invalid amount %s",
    async (amount) => {
      const result = await buildAtomicSwap(trader, {
        selling,
        amount,
        buying,
        maxSlippage: 1,
        priceFeed: priceFeed(),
      });

      expect(result.status).toBe("error");
    },
  );

  it("rejects malformed or identical assets", async () => {
    const malformed = await buildAtomicSwap(trader, {
      selling: { code: "EURC" },
      amount: "10",
      buying,
      maxSlippage: 1,
      priceFeed: priceFeed(),
    });
    const identical = await buildAtomicSwap(trader, {
      selling: Asset.native(),
      amount: "10",
      buying: Asset.native(),
      maxSlippage: 1,
      priceFeed: priceFeed(),
    });

    expect(malformed.status).toBe("error");
    expect(identical.status).toBe("error");
  });

  it("returns validation errors for malformed options and trader accounts", async () => {
    const malformedOptions = await buildAtomicSwap(trader, undefined as any);
    const malformedTrader = await buildAtomicSwap(
      { accountId: () => { throw new Error("invalid account accessor"); } },
      {
        selling,
        amount: "10",
        buying,
        maxSlippage: 1,
        priceFeed: priceFeed(),
      },
    );

    expect(malformedOptions.status).toBe("error");
    expect(malformedTrader.status).toBe("error");
  });

  it("rejects unavailable, stale, and invalid price quotes", async () => {
    const result = await buildAtomicSwap(trader, {
      selling,
      amount: "10",
      buying,
      maxSlippage: 1,
      priceFeed: {
        getPrice: async (asset: string) => ({
          asset,
          price: asset === "XLM" ? 1 : 0,
          currency: "USD",
          status: "stale",
        }),
      },
    });

    expect(result.status).toBe("error");
  });
});