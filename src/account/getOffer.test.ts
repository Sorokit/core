import { beforeEach, describe, expect, it, vi } from "vitest";
import { SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { OfferInfo } from "./dexActivity";

// Mock only the Horizon server construction so no request leaves the process.
// `horizon.offer` records the id the offer endpoint was asked for, and
// `horizon.call` is what the Horizon call resolves or rejects with.
const horizon = vi.hoisted(() => ({
  call: vi.fn(),
  offer: vi.fn(),
  urls: [] as string[],
}));

vi.mock("../shared/serverFactory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/serverFactory")>();
  return {
    ...actual,
    createHorizonServer: vi.fn((url: string) => {
      horizon.urls.push(url);
      return {
        offers: () => ({
          offer: (id: string) => {
            horizon.offer(id);
            return { call: horizon.call };
          },
        }),
      };
    }),
  };
});

import * as sorokitCore from "../index";
import * as accountModule from "./index";
import { getOfferById } from "./dexActivity";
import { resolveAccountQueryHorizonUrl } from "./paymentHistory";
import { getAccountOffer, getOffer } from "./queries";

const SELLER = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";
const ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

function horizonOffer(overrides: Record<string, unknown> = {}) {
  return {
    id: "12345",
    paging_token: "12345",
    seller: SELLER,
    selling: { asset_type: "native" },
    buying: { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER },
    amount: "250.0000000",
    price: "0.1250000",
    price_r: { n: 1, d: 8 },
    last_modified_ledger: 777,
    ...overrides,
  };
}

const horizonError = (status: number, message: string) =>
  Object.assign(new Error(message), { response: { status } });

function expectOk(result: SorokitResult<OfferInfo>): OfferInfo {
  if (result.status !== "ok") {
    throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  }
  return result.data;
}

function expectError(result: SorokitResult<OfferInfo>) {
  if (result.status !== "error") throw new Error("expected an error result");
  return result.error;
}

beforeEach(() => {
  horizon.call.mockReset();
  horizon.offer.mockReset();
  horizon.urls.length = 0;
  horizon.call.mockResolvedValue(horizonOffer());
});

describe("getOffer", () => {
  it("returns the offer's seller, price and amount", async () => {
    const offer = expectOk(await getOffer("12345"));

    expect(offer.id).toBe("12345");
    expect(offer.seller).toBe(SELLER);
    expect(offer.price).toBe("0.1250000");
    expect(offer.amount).toBe("250.0000000");
    expect(offer.lastModifiedLedger).toBe(777);
    expect(offer.pagingToken).toBe("12345");
  });

  it("describes the selling and buying assets", async () => {
    const offer = expectOk(await getOffer("12345"));

    expect(offer.selling).toMatchObject({ type: "native", code: "XLM" });
    expect(offer.buying).toMatchObject({ code: "USDC", issuer: ISSUER });
  });

  it.each([
    {
      name: "native for an issued asset",
      record: horizonOffer(),
      selling: { code: "XLM" },
      buying: { code: "USDC", issuer: ISSUER },
    },
    {
      name: "an issued asset for native",
      record: horizonOffer({
        selling: { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER },
        buying: { asset_type: "native" },
        price: "8.0000000",
      }),
      selling: { code: "USDC", issuer: ISSUER },
      buying: { code: "XLM" },
    },
    {
      name: "one issued asset for another",
      record: horizonOffer({
        selling: { asset_type: "credit_alphanum4", asset_code: "EURT", asset_issuer: ISSUER },
        buying: { asset_type: "credit_alphanum12", asset_code: "LONGASSET12", asset_issuer: SELLER },
      }),
      selling: { code: "EURT", issuer: ISSUER },
      buying: { code: "LONGASSET12", issuer: SELLER },
    },
  ])("maps $name", async ({ record, selling, buying }) => {
    horizon.call.mockResolvedValue(record);

    const offer = expectOk(await getOffer("12345"));

    expect(offer.selling).toMatchObject(selling);
    expect(offer.buying).toMatchObject(buying);
  });

  it("converts a numeric id from Horizon to a string id", async () => {
    horizon.call.mockResolvedValue(horizonOffer({ id: 98765 }));

    expect(expectOk(await getOffer("98765")).id).toBe("98765");
  });

  it("asks Horizon for exactly the id it was given", async () => {
    await getOffer("12345");

    expect(horizon.offer).toHaveBeenCalledTimes(1);
    expect(horizon.offer).toHaveBeenCalledWith("12345");
  });

  it("accepts a numeric id", async () => {
    await getOffer(12345);

    expect(horizon.offer).toHaveBeenCalledWith("12345");
  });

  it("trims whitespace around a string id", async () => {
    await getOffer("  12345 ");

    expect(horizon.offer).toHaveBeenCalledWith("12345");
  });

  it("passes a 64-bit id through unchanged instead of rounding it as a number", async () => {
    await getOffer("9007199254740993");

    expect(horizon.offer).toHaveBeenCalledWith("9007199254740993");
  });

  it("uses the default Horizon URL when none is given", async () => {
    await getOffer("12345");

    expect(horizon.urls).toEqual([resolveAccountQueryHorizonUrl()]);
  });

  it("uses a Horizon URL passed first", async () => {
    await getOffer("https://horizon.example.org", "12345");

    expect(horizon.urls).toEqual(["https://horizon.example.org"]);
    expect(horizon.offer).toHaveBeenCalledWith("12345");
  });

  it("is also available as getAccountOffer", () => {
    expect(getAccountOffer).toBe(getOffer);
  });
});

describe("getOffer failures", () => {
  it("returns OFFER_NOT_FOUND when Horizon answers 404", async () => {
    horizon.call.mockRejectedValue(horizonError(404, "Resource Missing"));

    const error = expectError(await getOffer("424242"));

    expect(error.code).toBe(SorokitErrorCode.OFFER_NOT_FOUND);
    expect(error.message).toContain("424242");
  });

  it("returns OFFER_NOT_FOUND when the failure says the offer was not found", async () => {
    horizon.call.mockRejectedValue(new Error("offer Not Found"));

    expect(expectError(await getOffer("424242")).code).toBe(SorokitErrorCode.OFFER_NOT_FOUND);
  });

  it("keeps the original Horizon error as the cause", async () => {
    const failure = horizonError(404, "Resource Missing");
    horizon.call.mockRejectedValue(failure);

    expect(expectError(await getOffer("424242")).cause).toBe(failure);
  });

  it.each([
    ["a server error", horizonError(500, "Internal Server Error")],
    ["a rate limit", horizonError(429, "Too Many Requests")],
    ["a network failure", new Error("socket hang up")],
  ])("returns ACCOUNT_FETCH_FAILED for %s, not a not-found", async (_name, failure) => {
    horizon.call.mockRejectedValue(failure);

    const error = expectError(await getOffer("12345"));

    expect(error.code).toBe(SorokitErrorCode.ACCOUNT_FETCH_FAILED);
    expect(error.message).toContain("Failed to fetch offer 12345");
    expect(error.cause).toBe(failure);
  });

  it("never throws, even when Horizon rejects with something that is not an Error", async () => {
    horizon.call.mockRejectedValue("boom");

    await expect(getOffer("12345")).resolves.toMatchObject({ status: "error" });
  });

  it("reports a malformed Horizon record as an error result instead of throwing", async () => {
    horizon.call.mockResolvedValue({ id: "12345" });

    await expect(getOffer("12345")).resolves.toMatchObject({
      status: "error",
      error: { code: SorokitErrorCode.ACCOUNT_FETCH_FAILED },
    });
  });

  it.each([
    ["an empty string", ""],
    ["whitespace", "   "],
    ["zero", "0"],
    ["a negative number", "-5"],
    ["a decimal", "12.5"],
    ["a non-numeric string", "abc"],
    ["scientific notation", "1e3"],
    ["a leading zero", "012"],
    ["an id with a path in it", "123/../456"],
    ["a numeric zero", 0],
    ["a negative numeric id", -1],
    ["a fractional numeric id", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a number too large to be exact", Number.MAX_SAFE_INTEGER + 1],
  ])("rejects %s without calling Horizon", async (_name, id) => {
    const error = expectError(await getOffer(id as string | number));

    expect(error.code).toBe(SorokitErrorCode.VALIDATION);
    expect(error.message).toContain("Invalid offer id");
    expect(horizon.offer).not.toHaveBeenCalled();
    expect(horizon.urls).toEqual([]);
  });
});

describe("getOfferById", () => {
  it("fetches from the given Horizon URL", async () => {
    expectOk(await getOfferById("https://horizon.example.org", "12345"));

    expect(horizon.urls).toEqual(["https://horizon.example.org"]);
    expect(horizon.offer).toHaveBeenCalledWith("12345");
  });

  it("returns an error result for an invalid id", async () => {
    expect(expectError(await getOfferById("https://horizon.example.org", "x")).code).toBe(
      SorokitErrorCode.VALIDATION,
    );
  });
});

describe("OFFER_NOT_FOUND", () => {
  it("is a stable error code", () => {
    expect(SorokitErrorCode.OFFER_NOT_FOUND).toBe("OFFER_NOT_FOUND");
  });
});

describe("exports", () => {
  it("is exported from src/account/index.ts", () => {
    expect(accountModule.getOffer).toBe(getOffer);
    expect(accountModule.getAccountOffer).toBe(getOffer);
  });

  it("is exported from src/index.ts", () => {
    expect(sorokitCore.getOffer).toBe(getOffer);
    expect(sorokitCore.getAccountOffer).toBe(getOffer);
  });
});
