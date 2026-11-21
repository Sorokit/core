import { beforeEach, describe, expect, it, vi } from "vitest";
import { Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  getAccount,
  invalidateAccount,
  clearAccountDeduplication,
  refreshAccountSequence,
} from "../account/getAccount";
import { getAccountsBatch } from "../account/getAccountsBatch";
import { submitTransaction } from "../transaction/submitTransaction";
import { clearInflightRequests, getInflightRequestCount } from "../shared/utils";
import { SorokitErrorCode } from "../shared/response";
import * as serverFactory from "../shared/serverFactory";

describe("account fetching with concurrent request deduplication (#390)", () => {
  const publicKeyA = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA";
  const publicKeyB = "GBBD47UZQ5JAKVEWZNRPA7MKSTIRZU27I27ULMOWVNQZLBZZW7QTXN00";
  const horizonUrl = "https://horizon.test";

  const mockAccountA = {
    sequence: "12345",
    subentry_count: 2,
    balances: [{ asset_type: "native", balance: "100.0000000" }],
  };

  const mockAccountB = {
    sequence: "67890",
    subentry_count: 1,
    balances: [{ asset_type: "native", balance: "50.0000000" }],
  };

  beforeEach(() => {
    clearInflightRequests();
    clearAccountDeduplication();
    vi.restoreAllMocks();
  });

  it("deduplicates N identical concurrent getAccount calls to a single Horizon request", async () => {
    const mockLoadAccount = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return mockAccountA;
    });

    vi.spyOn(serverFactory, "createHorizonServer").mockReturnValue({
      loadAccount: mockLoadAccount,
    } as any);

    const [res1, res2, res3, res4] = await Promise.all([
      getAccount(horizonUrl, publicKeyA),
      getAccount(horizonUrl, publicKeyA),
      getAccount(horizonUrl, publicKeyA),
      getAccount(horizonUrl, publicKeyA),
    ]);

    expect(mockLoadAccount).toHaveBeenCalledTimes(1);
    expect(res1.status).toBe("ok");
    expect(res2.status).toBe("ok");
    expect(res3.status).toBe("ok");
    expect(res4.status).toBe("ok");
    if (res1.status === "ok" && res2.status === "ok") {
      expect(res1.data.sequence).toBe("12345");
      expect(res2.data).toEqual(res1.data);
    }
  });

  it("shares successful results across multiple concurrent callers", async () => {
    const mockLoadAccount = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return mockAccountA;
    });

    vi.spyOn(serverFactory, "createHorizonServer").mockReturnValue({
      loadAccount: mockLoadAccount,
    } as any);

    const promises = Array.from({ length: 10 }, () => getAccount(horizonUrl, publicKeyA));
    const results = await Promise.all(promises);

    expect(mockLoadAccount).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(10);
    for (const res of results) {
      expect(res.status).toBe("ok");
      if (res.status === "ok") {
        expect(res.data.sequence).toBe("12345");
        expect(res.data.publicKey).toBe(publicKeyA);
      }
    }
  });

  it("propagates shared failure correctly across all concurrent callers", async () => {
    const notFoundError = {
      response: { status: 404 },
      message: "Account not found",
    };

    const mockLoadAccount = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw notFoundError;
    });

    vi.spyOn(serverFactory, "createHorizonServer").mockReturnValue({
      loadAccount: mockLoadAccount,
    } as any);

    const [res1, res2, res3] = await Promise.all([
      getAccount(horizonUrl, publicKeyA),
      getAccount(horizonUrl, publicKeyA),
      getAccount(horizonUrl, publicKeyA),
    ]);

    expect(mockLoadAccount).toHaveBeenCalledTimes(1);
    expect(res1.status).toBe("error");
    expect(res2.status).toBe("error");
    expect(res3.status).toBe("error");
    if (res1.status === "error" && res2.status === "error") {
      expect(res1.error.code).toBe(SorokitErrorCode.ACCOUNT_NOT_FOUND);
      expect(res2.error.code).toBe(SorokitErrorCode.ACCOUNT_NOT_FOUND);
    }
  });

  it("removes in-flight entries after completion and allows subsequent requests", async () => {
    const mockLoadAccount = vi.fn().mockResolvedValue(mockAccountA);
    vi.spyOn(serverFactory, "createHorizonServer").mockReturnValue({
      loadAccount: mockLoadAccount,
    } as any);

    const first = await getAccount(horizonUrl, publicKeyA);
    expect(first.status).toBe("ok");
    expect(mockLoadAccount).toHaveBeenCalledTimes(1);
    expect(getInflightRequestCount()).toBe(0);

    const second = await getAccount(horizonUrl, publicKeyA);
    expect(second.status).toBe("ok");
    expect(mockLoadAccount).toHaveBeenCalledTimes(2);
    expect(getInflightRequestCount()).toBe(0);
  });

  it("allows subsequent requests after a failure", async () => {
    const notFoundError = {
      response: { status: 404 },
      message: "Account not found",
    };

    const mockLoadAccount = vi
      .fn()
      .mockRejectedValueOnce(notFoundError)
      .mockResolvedValueOnce(mockAccountA);

    vi.spyOn(serverFactory, "createHorizonServer").mockReturnValue({
      loadAccount: mockLoadAccount,
    } as any);

    const first = await getAccount(horizonUrl, publicKeyA);
    expect(first.status).toBe("error");
    expect(mockLoadAccount).toHaveBeenCalledTimes(1);
    expect(getInflightRequestCount()).toBe(0);

    const second = await getAccount(horizonUrl, publicKeyA);
    expect(second.status).toBe("ok");
    expect(mockLoadAccount).toHaveBeenCalledTimes(2);
    expect(getInflightRequestCount()).toBe(0);
  });

  it("preserves concurrency for different accounts", async () => {
    const mockLoadAccount = vi.fn().mockImplementation(async (key: string) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return key === publicKeyA ? mockAccountA : mockAccountB;
    });

    vi.spyOn(serverFactory, "createHorizonServer").mockReturnValue({
      loadAccount: mockLoadAccount,
    } as any);

    const [resA, resB] = await Promise.all([
      getAccount(horizonUrl, publicKeyA),
      getAccount(horizonUrl, publicKeyB),
    ]);

    expect(mockLoadAccount).toHaveBeenCalledTimes(2);
    expect(resA.status).toBe("ok");
    expect(resB.status).toBe("ok");
    if (resA.status === "ok" && resB.status === "ok") {
      expect(resA.data.sequence).toBe("12345");
      expect(resB.data.sequence).toBe("67890");
    }
  });

  it("deduplicates duplicate accounts in getAccountsBatch requests", async () => {
    const mockLoadAccount = vi.fn().mockImplementation(async (key: string) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return key === publicKeyA ? mockAccountA : mockAccountB;
    });

    vi.spyOn(serverFactory, "createHorizonServer").mockReturnValue({
      loadAccount: mockLoadAccount,
    } as any);

    const batchResult = await getAccountsBatch(horizonUrl, [
      publicKeyA,
      publicKeyB,
      publicKeyA,
      publicKeyA,
      publicKeyB,
    ]);

    expect(mockLoadAccount).toHaveBeenCalledTimes(2);
    expect(batchResult.status).toBe("ok");
    if (batchResult.status === "ok") {
      expect(batchResult.data).toHaveLength(5);
      expect(batchResult.data[0].status).toBe("ok");
      expect(batchResult.data[1].status).toBe("ok");
      expect(batchResult.data[2].status).toBe("ok");
      expect(batchResult.data[3].status).toBe("ok");
      expect(batchResult.data[4].status).toBe("ok");
      expect((batchResult.data[0] as any).data.sequence).toBe("12345");
      expect((batchResult.data[1] as any).data.sequence).toBe("67890");
      expect((batchResult.data[2] as any).data.sequence).toBe("12345");
      expect((batchResult.data[3] as any).data.sequence).toBe("12345");
      expect((batchResult.data[4] as any).data.sequence).toBe("67890");
    }
  });

  describe("sequence-aware deduplication and mutation invalidation (#752)", () => {
    it("reflects the incremented sequence on next fetch after account mutation invalidation", async () => {
      let currentSeq = "100";
      const mockLoadAccount = vi.fn().mockImplementation(async () => {
        return {
          sequence: currentSeq,
          subentry_count: 1,
          balances: [{ asset_type: "native", balance: "100.0000000" }],
        };
      });

      vi.spyOn(serverFactory, "createHorizonServer").mockReturnValue({
        loadAccount: mockLoadAccount,
      } as any);

      // Rapid concurrent fetches before mutation get the exact same sequence (deduplicated)
      const [res1, res2] = await Promise.all([
        getAccount(horizonUrl, publicKeyA),
        getAccount(horizonUrl, publicKeyA),
      ]);

      expect(mockLoadAccount).toHaveBeenCalledTimes(1);
      expect(res1.status).toBe("ok");
      expect(res2.status).toBe("ok");
      if (res1.status === "ok" && res2.status === "ok") {
        expect(res1.data.sequence).toBe("100");
        expect(res2.data.sequence).toBe("100");
      }

      // Simulate a transaction submission/mutation: sequence increments on ledger
      currentSeq = "101";
      invalidateAccount(publicKeyA, horizonUrl);

      // Next fetch reflects the incremented sequence, not cached old value
      const res3 = await getAccount(horizonUrl, publicKeyA);
      expect(mockLoadAccount).toHaveBeenCalledTimes(2);
      expect(res3.status).toBe("ok");
      if (res3.status === "ok") {
        expect(res3.data.sequence).toBe("101");
      }
    });

    it("evicts in-flight requests when mutation occurs concurrently with fetches", async () => {
      let callCount = 0;
      const mockLoadAccount = vi.fn().mockImplementation(async () => {
        callCount++;
        const seq = callCount === 1 ? "100" : "101";
        await new Promise((resolve) => setTimeout(resolve, 30));
        return {
          sequence: seq,
          subentry_count: 1,
          balances: [{ asset_type: "native", balance: "100.0000000" }],
        };
      });

      vi.spyOn(serverFactory, "createHorizonServer").mockReturnValue({
        loadAccount: mockLoadAccount,
      } as any);

      // Start first fetch (which takes 30ms)
      const fetch1Promise = getAccount(horizonUrl, publicKeyA);

      // While fetch1 is in-flight, a mutation occurs and invalidates the account
      invalidateAccount(publicKeyA, horizonUrl);

      // Second fetch starts after mutation
      const fetch2Promise = getAccount(horizonUrl, publicKeyA);

      const [res1, res2] = await Promise.all([fetch1Promise, fetch2Promise]);

      expect(mockLoadAccount).toHaveBeenCalledTimes(2);
      expect(res1.status).toBe("ok");
      expect(res2.status).toBe("ok");
      if (res1.status === "ok" && res2.status === "ok") {
        expect(res1.data.sequence).toBe("100");
        expect(res2.data.sequence).toBe("101");
      }
    });

    it("differentiates deduplication keys when explicit sequence / expectedSequence is provided", async () => {
      const mockLoadAccount = vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return mockAccountA;
      });

      vi.spyOn(serverFactory, "createHorizonServer").mockReturnValue({
        loadAccount: mockLoadAccount,
      } as any);

      // Rapid concurrent calls expecting different sequences do not share the deduplication key
      const [resSeq1, resSeq2] = await Promise.all([
        getAccount(horizonUrl, publicKeyA, { sequence: "100" }),
        getAccount(horizonUrl, publicKeyA, { sequence: "101" }),
      ]);

      expect(mockLoadAccount).toHaveBeenCalledTimes(2);
      expect(resSeq1.status).toBe("ok");
      expect(resSeq2.status).toBe("ok");
    });

    it("bypasses deduplication and forces fresh fetch when forceRefresh is true", async () => {
      let currentSeq = "200";
      const mockLoadAccount = vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          sequence: currentSeq,
          subentry_count: 1,
          balances: [{ asset_type: "native", balance: "100.0000000" }],
        };
      });

      vi.spyOn(serverFactory, "createHorizonServer").mockReturnValue({
        loadAccount: mockLoadAccount,
      } as any);

      const p1 = getAccount(horizonUrl, publicKeyA);
      currentSeq = "201";
      const p2 = getAccount(horizonUrl, publicKeyA, { forceRefresh: true });

      const [res1, res2] = await Promise.all([p1, p2]);

      expect(mockLoadAccount).toHaveBeenCalledTimes(2);
      expect(res1.status).toBe("ok");
      expect(res2.status).toBe("ok");
      if (res2.status === "ok") {
        expect(res2.data.sequence).toBe("201");
      }
    });

    it("automatically invalidates account sequence when submitTransaction succeeds", async () => {
      const TESTNET_XDR =
        "AAAAAgAAAAArg6xVmhrfK8Kf1L0wCEKReWNmDUacUNz/RAwldACowwAAAGQAAAAAAAAAAQAAAAEAAAAAAAAAAAAAAABqO6RQAAAAAAAAAAEAAAAAAAAACQAAAAAAAAABdACowwAAAEBh9aFJaCgi8jCtB4tqReRPYyywWPIWl6v1+92iXCdqsKGvoxRafpQiAIdvHr6+Jw2Ybd4Vs89XDO0nDVtwip4K";

      let currentSeq = "1000";
      const mockLoadAccount = vi.fn().mockImplementation(async () => {
        return {
          sequence: currentSeq,
          subentry_count: 1,
          balances: [{ asset_type: "native", balance: "500.0000000" }],
        };
      });

      const mockSubmitTransaction = vi.fn().mockResolvedValue({
        hash: "deadbeef",
        ledger: 1234,
        envelope_xdr: TESTNET_XDR,
        result_xdr: "",
      });

      vi.spyOn(serverFactory, "createHorizonServer").mockReturnValue({
        loadAccount: mockLoadAccount,
        submitTransaction: mockSubmitTransaction,
      } as any);

      const tx = TransactionBuilder.fromXDR(TESTNET_XDR, Networks.TESTNET);
      const sourceKey = tx.source;

      // 1. Fetch account initially
      const initial = await getAccount(horizonUrl, sourceKey);
      expect(initial.status).toBe("ok");
      if (initial.status === "ok") {
        expect(initial.data.sequence).toBe("1000");
      }

      // 2. Submit transaction consuming sequence
      currentSeq = "1001";
      const submitRes = await submitTransaction(horizonUrl, Networks.TESTNET, TESTNET_XDR);
      expect(submitRes.status).toBe("ok");

      // 3. Next fetch reflects the incremented sequence
      const refreshed = await getAccount(horizonUrl, sourceKey);
      expect(refreshed.status).toBe("ok");
      if (refreshed.status === "ok") {
        expect(refreshed.data.sequence).toBe("1001");
      }
      expect(mockLoadAccount).toHaveBeenCalledTimes(2);
    });
  });
});
