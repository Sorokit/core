import { describe, it, expect, vi, beforeEach } from "vitest";
import { SorokitErrorCode } from "../shared/response";
import {
  isTimeoutError,
  isNetworkConnectivityError,
  isXdrInvalidError,
  isNotFoundError,
  isUserRejection,
  isTransientError,
  isValidPublicKey,
  isValidContractId,
  retryWithBackoff,
} from "../shared";

// Mocked Horizon server — getAccount goes through this.
// Hoisted so the vi.mock factory (itself hoisted) can reference it safely.
const { mockLoadAccount } = vi.hoisted(() => ({ mockLoadAccount: vi.fn() }));

vi.mock("@stellar/stellar-sdk", () => ({
  Horizon: {
    Server: class {
      loadAccount = mockLoadAccount;
    },
  },
  // Stubs to satisfy import bindings of submitTransaction / simulateTransaction.
  // The error paths exercised below return before these are used.
  TransactionBuilder: { fromXDR: vi.fn() },
  Keypair: {},
  FeeBumpTransaction: class {},
  rpc: { Server: class {}, Api: {} },
}));

import { getAccount } from "../account/getAccount";
import { submitTransaction } from "../transaction/submitTransaction";
import { simulateTransaction } from "../soroban/simulateTransaction";
import { connectWallet } from "../wallet/connect";
import { ok, err } from "../shared/response";
import type { WalletAdapter } from "../wallet/types";
import { WalletType } from "../wallet/types";

beforeEach(() => {
  mockLoadAccount.mockReset();
});

const PK = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA";

describe("error scenarios (#31)", () => {
  // ─── account.getAccount ───────────────────────────────────────────────────
  describe("account.getAccount", () => {
    it("maps a 404 to ACCOUNT_NOT_FOUND", async () => {
      mockLoadAccount.mockRejectedValue(new Error("Request failed with status 404 Not Found"));
      const result = await getAccount("https://horizon.test", PK);
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.ACCOUNT_NOT_FOUND);
      }
    });

    it("maps a generic failure to ACCOUNT_FETCH_FAILED without retrying", async () => {
      mockLoadAccount.mockRejectedValue(new Error("kaboom"));
      const result = await getAccount("https://horizon.test", PK);
      if (result.status !== "error") throw new Error("expected error");
      expect(result.error.code).toBe(SorokitErrorCode.ACCOUNT_FETCH_FAILED);
      expect(mockLoadAccount).toHaveBeenCalledTimes(1);
    });

    it("retries transient network failures then fails", async () => {
      mockLoadAccount.mockRejectedValue(
        Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
      );
      const result = await getAccount("https://horizon.test", PK);
      if (result.status !== "error") throw new Error("expected error");
      expect(result.error.code).toBe(SorokitErrorCode.ACCOUNT_FETCH_FAILED);
      expect(mockLoadAccount).toHaveBeenCalledTimes(3); // exhausts retries
    });

    it("does not retry a 429 rate-limit response", async () => {
      mockLoadAccount.mockRejectedValue({ response: { status: 429 } });
      const result = await getAccount("https://horizon.test", PK);
      if (result.status !== "error") throw new Error("expected error");
      expect(result.error.code).toBe(SorokitErrorCode.ACCOUNT_FETCH_FAILED);
      expect(mockLoadAccount).toHaveBeenCalledTimes(1);
    });

    it("recovers when a transient failure clears within the retry budget", async () => {
      mockLoadAccount
        .mockRejectedValueOnce(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }))
        .mockResolvedValueOnce({
          balances: [{ asset_type: "native", balance: "100" }],
          sequence: "1",
          subentry_count: 0,
        });
      const result = await getAccount("https://horizon.test", PK);
      expect(result.status).toBe("ok");
      expect(mockLoadAccount).toHaveBeenCalledTimes(2);
    });

    it("fails every concurrent caller when Horizon is down", async () => {
      mockLoadAccount.mockRejectedValue(new Error("kaboom"));
      const results = await Promise.all([
        getAccount("https://horizon.test", PK),
        getAccount("https://horizon.test", PK),
        getAccount("https://horizon.test", PK),
      ]);
      expect(results.every((r) => r.status === "error")).toBe(true);
    });
  });

  // ─── transaction.submitTransaction ──────────────────────────────────────────
  describe("transaction.submitTransaction", () => {
    it("rejects an empty XDR with TX_SUBMIT_FAILED", async () => {
      const result = await submitTransaction("https://horizon.test", "Test", "");
      if (result.status !== "error") throw new Error("expected error");
      expect(result.error.code).toBe(SorokitErrorCode.TX_SUBMIT_FAILED);
    });

    it("rejects a non-base64 XDR with TX_SUBMIT_FAILED", async () => {
      const result = await submitTransaction("https://horizon.test", "Test", "!!!not-xdr!!!");
      if (result.status !== "error") throw new Error("expected error");
      expect(result.error.code).toBe(SorokitErrorCode.TX_SUBMIT_FAILED);
    });
  });

  // ─── soroban.simulateTransaction ────────────────────────────────────────────
  describe("soroban.simulateTransaction", () => {
    it("rejects a malformed XDR with TX_SIMULATE_FAILED", async () => {
      const result = await simulateTransaction("https://rpc.test", "Test", "");
      if (result.status !== "error") throw new Error("expected error");
      expect(result.error.code).toBe(SorokitErrorCode.TX_SIMULATE_FAILED);
    });

    it("rejects whitespace-only XDR with TX_SIMULATE_FAILED", async () => {
      const result = await simulateTransaction("https://rpc.test", "Test", "   ");
      if (result.status !== "error") throw new Error("expected error");
      expect(result.error.code).toBe(SorokitErrorCode.TX_SIMULATE_FAILED);
    });
  });

  // ─── wallet.connectWallet ───────────────────────────────────────────────────
  describe("wallet.connectWallet", () => {
    function adapter(overrides?: Partial<WalletAdapter>): WalletAdapter {
      return {
        walletType: WalletType.FREIGHTER,
        isAvailable: () => true,
        connect: async () => ok(PK),
        disconnect: async () => ok(undefined),
        signTransaction: async () => ok("signed"),
        ...overrides,
      };
    }

    it("returns WALLET_BROWSER_ONLY when the wallet is unavailable", async () => {
      const result = await connectWallet(adapter({ isAvailable: () => false }));
      if (result.status !== "error") throw new Error("expected error");
      expect(result.error.code).toBe(SorokitErrorCode.WALLET_BROWSER_ONLY);
    });

    it("propagates a connect failure from the adapter", async () => {
      const result = await connectWallet(
        adapter({
          connect: async () => err(SorokitErrorCode.WALLET_CONNECT_FAILED, "rejected"),
        }),
      );
      if (result.status !== "error") throw new Error("expected error");
      expect(result.error.code).toBe(SorokitErrorCode.WALLET_CONNECT_FAILED);
    });
  });

  // ─── shared error classifiers ───────────────────────────────────────────────
  describe("error classifiers", () => {
    it("detects timeout errors across shapes", () => {
      expect(isTimeoutError(Object.assign(new Error("x"), { name: "AbortError" }))).toBe(true);
      expect(isTimeoutError(Object.assign(new Error("x"), { code: "ETIMEDOUT" }))).toBe(true);
      expect(isTimeoutError(new Error("operation timed out"))).toBe(true);
      expect(isTimeoutError(new Error("deadline exceeded"))).toBe(true);
      expect(isTimeoutError(new Error("ok"))).toBe(false);
    });

    it("detects network connectivity errors across shapes", () => {
      expect(isNetworkConnectivityError(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe(true);
      expect(isNetworkConnectivityError(Object.assign(new Error("x"), { code: "ENOTFOUND" }))).toBe(true);
      expect(isNetworkConnectivityError(new Error("fetch failed"))).toBe(true);
      expect(isNetworkConnectivityError(new Error("network unreachable"))).toBe(true);
      expect(isNetworkConnectivityError(new Error("ok"))).toBe(false);
    });

    it("detects malformed XDR for invalid inputs", () => {
      expect(isXdrInvalidError("")).toBe(true);
      expect(isXdrInvalidError("   ")).toBe(true);
      expect(isXdrInvalidError("@@@not-base64@@@")).toBe(true);
      expect(isXdrInvalidError(new Error("XDR Read Error: bad union switch"))).toBe(true);
    });

    it("detects not-found errors from message and status", () => {
      expect(isNotFoundError(new Error("404 not found"))).toBe(true);
      expect(isNotFoundError({ response: { status: 404 } })).toBe(true);
      expect(isNotFoundError({ response: { status: 500 } })).toBe(false);
    });

    it("detects user rejections", () => {
      expect(isUserRejection(new Error("User declined the request"))).toBe(true);
      expect(isUserRejection(new Error("request cancelled"))).toBe(true);
      expect(isUserRejection(new Error("approved"))).toBe(false);
    });

    it("classifies transient vs permanent errors", () => {
      expect(isTransientError({ response: { status: 503 } })).toBe(true);
      expect(isTransientError(Object.assign(new Error("x"), { code: "ETIMEDOUT" }))).toBe(true);
      expect(isTransientError({ response: { status: 400 } })).toBe(false);
      expect(isTransientError(new Error("bad input"))).toBe(false);
    });

    it("validates public keys and contract IDs at boundaries", () => {
      expect(isValidPublicKey(PK)).toBe(true);
      expect(isValidPublicKey("")).toBe(false);
      expect(isValidPublicKey("G123")).toBe(false);
      expect(isValidPublicKey(`${PK}EXTRA`)).toBe(false);
      expect(isValidContractId("notacontract")).toBe(false);
    });
  });

  // ─── retryWithBackoff edge cases ──────────────────────────────────────────────
  describe("retryWithBackoff", () => {
    it("does not retry permanent errors", async () => {
      const fn = vi.fn(async () => {
        throw new Error("permanent");
      });
      await expect(retryWithBackoff(fn, { initialDelayMs: 1 })).rejects.toThrow("permanent");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("retries transient errors up to maxAttempts then throws", async () => {
      const fn = vi.fn(async () => {
        throw Object.assign(new Error("down"), { code: "ECONNRESET" });
      });
      await expect(
        retryWithBackoff(fn, { maxAttempts: 3, initialDelayMs: 1 }),
      ).rejects.toThrow("down");
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it("returns the value once a transient error clears", async () => {
      let calls = 0;
      const fn = vi.fn(async () => {
        calls++;
        if (calls < 2) throw Object.assign(new Error("blip"), { code: "ETIMEDOUT" });
        return "value";
      });
      await expect(retryWithBackoff(fn, { initialDelayMs: 1 })).resolves.toBe("value");
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });
});
