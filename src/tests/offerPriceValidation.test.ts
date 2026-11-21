import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { ResolvedNetworkConfig } from "../shared/types";
import { compose } from "../transaction/compose";
import {
  DEFAULT_MAX_OFFER_PRICE,
  DEFAULT_MIN_OFFER_PRICE,
} from "../transaction/offerPrice";

const { mockLoadAccount } = vi.hoisted(() => ({
  mockLoadAccount: vi.fn(),
}));

const MOCK_XDR = "AAAAAQAAAAA=";

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();

  class MockTransactionBuilder {
    constructor(_sourceAccount: unknown, _options: unknown) {}

    addOperation() {
      return this;
    }

    setTimeout() {
      return this;
    }

    addMemo() {
      return this;
    }

    build() {
      return { toXDR: () => MOCK_XDR };
    }
  }

  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: vi.fn().mockImplementation(() => ({
        loadAccount: mockLoadAccount,
      })),
    },
    TransactionBuilder: MockTransactionBuilder,
  };
});

import { buildManageOfferTransaction } from "../transaction/buildTransaction";

const networkConfig: ResolvedNetworkConfig = {
  network: "testnet",
  horizonUrl: "https://horizon-testnet.stellar.org",
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
};

const TRADER = "GBTABBLFJWSIJKGRVJMOV477L42GXCHFHGDUOCDMC7MXWASTPZKQNB25";
const ISSUER = "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2";

const mockAccount = {
  accountId: () => TRADER,
  sequenceNumber: () => "1",
  incrementSequenceNumber: () => {},
};

const baseOffer = {
  sellingAssetCode: "XLM",
  buyingAssetCode: "EURC",
  buyingAssetIssuer: ISSUER,
  amount: "100",
};

describe("offer price ratio validation", () => {
  let warning: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockLoadAccount.mockResolvedValue(mockAccount);
    warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warning.mockRestore();
  });

  it("warns for prices below the default minimum", async () => {
    const result = await buildManageOfferTransaction(
      networkConfig.horizonUrl,
      networkConfig,
      TRADER,
      { ...baseOffer, price: "0.0001" },
    );

    expect(result.status).toBe("ok");
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining(`[${DEFAULT_MIN_OFFER_PRICE}`),
    );
  });

  it("warns for prices above the default maximum, including rational prices", async () => {
    const result = await buildManageOfferTransaction(
      networkConfig.horizonUrl,
      networkConfig,
      TRADER,
      { ...baseOffer, price: { n: 1_000_000_000, d: 1 } as unknown as string },
    );

    expect(result.status).toBe("ok");
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining(`${DEFAULT_MAX_OFFER_PRICE}]`),
    );
  });

  it("allows callers to suppress the warning", async () => {
    const result = await buildManageOfferTransaction(
      networkConfig.horizonUrl,
      networkConfig,
      TRADER,
      { ...baseOffer, price: "0.0001", suppressPriceWarnings: true },
    );

    expect(result.status).toBe("ok");
    expect(warning).not.toHaveBeenCalled();
  });

  it("does not warn at the inclusive default boundaries", async () => {
    const composeBuilder = compose(TRADER, networkConfig, {
      sequenceNumber: "1",
      estimatedFee: "100",
    });

    composeBuilder.addManageOffer({
      selling: { assetCode: "XLM" },
      buying: { assetCode: "EURC", assetIssuer: ISSUER },
      amount: "100",
      price: String(DEFAULT_MIN_OFFER_PRICE),
    });
    composeBuilder.addManageOffer({
      selling: { assetCode: "XLM" },
      buying: { assetCode: "EURC", assetIssuer: ISSUER },
      amount: "100",
      price: String(DEFAULT_MAX_OFFER_PRICE),
    });

    expect(warning).not.toHaveBeenCalled();
  });

  it("warns from the compose builder and honors builder-level suppression", () => {
    compose(TRADER, networkConfig, { suppressPriceWarnings: true }).addManageOffer({
      selling: { assetCode: "XLM" },
      buying: { assetCode: "EURC", assetIssuer: ISSUER },
      amount: "100",
      price: "0.00001",
    });

    expect(warning).not.toHaveBeenCalled();

    compose(TRADER, networkConfig).addManageBuyOffer({
      selling: { assetCode: "XLM" },
      buying: { assetCode: "EURC", assetIssuer: ISSUER },
      amount: "100",
      price: "1001",
    });

    expect(warning).toHaveBeenCalledTimes(1);
  });
});
