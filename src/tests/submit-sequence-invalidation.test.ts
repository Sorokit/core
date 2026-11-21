/**
 * Tests that a sequence-related submission failure (tx_bad_seq) invalidates
 * the build-time `autoFetchSequence` cache for the affected account, so the
 * next build is forced to fetch a fresh sequence instead of reusing the
 * stale, now-incorrect one (#836).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSubmitTransaction, mockLoadAccount } = vi.hoisted(() => ({
  mockSubmitTransaction: vi.fn(),
  mockLoadAccount: vi.fn(),
}));

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: class {
        submitTransaction = mockSubmitTransaction;
        loadAccount = mockLoadAccount;
      },
    },
  };
});

import { submitTransaction } from "../transaction/submitTransaction";
import {
  buildPaymentTransaction,
  clearSequenceCache,
} from "../transaction/buildTransaction";
import type { ResolvedNetworkConfig } from "../shared/types";

// Real signed testnet XDR (inflation op, 30s timeout) — same fixture used by
// submit-transaction.test.ts. Source account public key below matches the
// signer so the passphrase/hint checks pass.
const TESTNET_XDR =
  "AAAAAgAAAAArg6xVmhrfK8Kf1L0wCEKReWNmDUacUNz/RAwldACowwAAAGQAAAAAAAAAAQAAAAEAAAAAAAAAAAAAAABqO6RQAAAAAAAAAAEAAAAAAAAACQAAAAAAAAABdACowwAAAEBh9aFJaCgi8jCtB4tqReRPYyywWPIWl6v1+92iXCdqsKGvoxRafpQiAIdvHr6+Jw2Ybd4Vs89XDO0nDVtwip4K";
const SOURCE_PUBLIC_KEY = "GAVYHLCVTINN6K6CT7KL2MAIIKIXSY3GBVDJYUG475CAYJLUACUMGUEW";

const networkConfig: ResolvedNetworkConfig = {
  horizonUrl: "https://horizon-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
};

function badSeqError() {
  return {
    response: {
      status: 400,
      data: {
        extras: { result_codes: { transaction: "tx_bad_seq" } },
      },
    },
  };
}

describe("submitTransaction — sequence cache invalidation on tx_bad_seq (#836)", () => {
  beforeEach(() => {
    mockSubmitTransaction.mockReset();
    mockLoadAccount.mockReset();
    clearSequenceCache();
  });

  it("invalidates the cached sequence for the source account after a tx_bad_seq failure", async () => {
    const mockAccount = {
      sequence: "100",
      sequenceNumber: vi.fn().mockReturnValue("101"),
      incrementSequenceNumber: vi.fn(),
      subentry_count: 0,
      balances: [],
      accountId: () => SOURCE_PUBLIC_KEY,
    };
    mockLoadAccount.mockResolvedValue(mockAccount);

    // Populate the build-time sequence cache for this account.
    const buildResult = await buildPaymentTransaction(
      networkConfig.horizonUrl,
      networkConfig,
      SOURCE_PUBLIC_KEY,
      {
        destination: "GAAL6LIAG2FGFQTKMUNGLCSCAM722PPYRVK2PXEMC6KNRRWLCFTYQD7R",
        amount: "10",
        autoFetchSequence: true,
      },
    );
    expect(buildResult.status).toBe("ok");
    expect(mockLoadAccount).toHaveBeenCalledOnce();
    mockLoadAccount.mockClear();

    // A submission for this same account fails with tx_bad_seq.
    mockSubmitTransaction.mockRejectedValueOnce(badSeqError());
    const submitResult = await submitTransaction(
      networkConfig.horizonUrl,
      networkConfig.networkPassphrase,
      TESTNET_XDR,
    );
    expect(submitResult.status).toBe("error");

    // The next autoFetchSequence build for the SAME account must re-fetch
    // from Horizon — the stale cached sequence must not be reused.
    const nextBuild = await buildPaymentTransaction(
      networkConfig.horizonUrl,
      networkConfig,
      SOURCE_PUBLIC_KEY,
      {
        destination: "GAAL6LIAG2FGFQTKMUNGLCSCAM722PPYRVK2PXEMC6KNRRWLCFTYQD7R",
        amount: "10",
        autoFetchSequence: true,
      },
    );
    expect(nextBuild.status).toBe("ok");
    expect(mockLoadAccount).toHaveBeenCalledOnce();
  });

  it("does not invalidate the sequence cache for a non-sequence submission failure", async () => {
    const mockAccount = {
      sequence: "100",
      sequenceNumber: vi.fn().mockReturnValue("101"),
      incrementSequenceNumber: vi.fn(),
      subentry_count: 0,
      balances: [],
      accountId: () => SOURCE_PUBLIC_KEY,
    };
    mockLoadAccount.mockResolvedValue(mockAccount);

    const buildResult = await buildPaymentTransaction(
      networkConfig.horizonUrl,
      networkConfig,
      SOURCE_PUBLIC_KEY,
      {
        destination: "GAAL6LIAG2FGFQTKMUNGLCSCAM722PPYRVK2PXEMC6KNRRWLCFTYQD7R",
        amount: "10",
        autoFetchSequence: true,
      },
    );
    expect(buildResult.status).toBe("ok");
    mockLoadAccount.mockClear();

    // Unrelated failure (e.g. insufficient fee) must NOT clear the cache.
    mockSubmitTransaction.mockRejectedValueOnce({
      response: {
        status: 400,
        data: { extras: { result_codes: { transaction: "tx_insufficient_fee" } } },
      },
    });
    const submitResult = await submitTransaction(
      networkConfig.horizonUrl,
      networkConfig.networkPassphrase,
      TESTNET_XDR,
    );
    expect(submitResult.status).toBe("error");

    const nextBuild = await buildPaymentTransaction(
      networkConfig.horizonUrl,
      networkConfig,
      SOURCE_PUBLIC_KEY,
      {
        destination: "GAAL6LIAG2FGFQTKMUNGLCSCAM722PPYRVK2PXEMC6KNRRWLCFTYQD7R",
        amount: "10",
        autoFetchSequence: true,
      },
    );
    expect(nextBuild.status).toBe("ok");
    // Cache was still warm — no new Horizon fetch needed.
    expect(mockLoadAccount).not.toHaveBeenCalled();
  });
});
