import { describe, expect, it, vi } from "vitest";
import { getAccountsBatch, getBalancesBatch } from "../account/batchQueries";
import * as getAccountModule from "../account/getAccount";
import * as getBalancesModule from "../account/getBalances";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { AccountInfo, AssetBalance } from "../account/types";

describe("Batch Account Operations (#957)", () => {
  const mockAccount1: AccountInfo = {
    publicKey: "GAAA",
    sequence: "100",
    balances: [{ assetType: "native", balance: "50.0" }],
    subentryCount: 0,
    thresholds: { lowThreshold: 0, medThreshold: 0, highThreshold: 0 },
    signers: [],
    data: {},
    flags: { authRequired: false, authRevocable: false, authImmutable: false, authClawbackEnabled: false },
  };

  const mockAccount2: AccountInfo = {
    ...mockAccount1,
    publicKey: "GBBB",
    sequence: "200",
  };

  it("handles empty publicKeys array", async () => {
    const res = await getAccountsBatch([]);
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.data).toEqual([]);
    }
  });

  it("fetches multiple accounts in parallel", async () => {
    const spy = vi.spyOn(getAccountModule, "getAccount").mockImplementation(async (_url, pubkey) => {
      if (pubkey === "GAAA") return ok(mockAccount1);
      if (pubkey === "GBBB") return ok(mockAccount2);
      return err(SorokitErrorCode.ACCOUNT_NOT_FOUND, "Not found");
    });

    const res = await getAccountsBatch(["GAAA", "GBBB"]);
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.data.length).toBe(2);
      expect(res.data[0]?.publicKey).toBe("GAAA");
      expect(res.data[1]?.publicKey).toBe("GBBB");
    }

    spy.mockRestore();
  });

  it("fetches multiple balances in parallel", async () => {
    const mockBalances: AssetBalance[] = [{ assetType: "native", balance: "100.0" }];
    const spy = vi.spyOn(getBalancesModule, "getBalances").mockResolvedValue(ok(mockBalances));

    const res = await getBalancesBatch(["GAAA", "GBBB"]);
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.data.length).toBe(2);
      expect(res.data[0]).toEqual(mockBalances);
    }

    spy.mockRestore();
  });

  it("handles partial failures gracefully", async () => {
    const spy = vi.spyOn(getAccountModule, "getAccount").mockImplementation(async (_url, pubkey) => {
      if (pubkey === "GAAA") return ok(mockAccount1);
      return err(SorokitErrorCode.ACCOUNT_NOT_FOUND, "Not found");
    });

    const res = await getAccountsBatch(["GAAA", "INVALID"]);
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.data.length).toBe(1);
      expect(res.data[0]?.publicKey).toBe("GAAA");
    }

    spy.mockRestore();
  });
});
