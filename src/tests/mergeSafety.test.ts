import { describe, expect, it, vi, afterEach } from "vitest";
import { simulateAccountMerge } from "../account/mergeSafety";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { AccountInfo } from "../account/types";

// ─── Mock getAccount ───────────────────────────────────────────────────────────
vi.mock("../account/getAccount", () => ({
  getAccount: vi.fn(),
}));

import { getAccount } from "../account/getAccount";
const mockGetAccount = vi.mocked(getAccount);

// ─── Test fixtures ─────────────────────────────────────────────────────────────

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const SOURCE_KEY =
  "GAIH3ULLFQ4DGSECF2AR555KZ4KNDGEKN4AFI4SU2M7B43MGK3QJZNSR";
const DEST_KEY =
  "GBVB43NLVIP2USHXKITLNWMGCTH6USHN4AF6PF2VBNNTXJKB23333333";

function makeAccount(overrides: Partial<AccountInfo> = {}): AccountInfo {
  return {
    publicKey: SOURCE_KEY,
    displayAddress: "GAIH3...ZNSR",
    sequence: "100",
    subentryCount: 0,
    balances: [
      {
        assetType: "native",
        assetCode: "XLM",
        assetIssuer: null,
        balance: "10.0000000",
        balanceFloat: 10,
      },
    ],
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("simulateAccountMerge", () => {
  describe("input validation", () => {
    it("returns INVALID_ADDRESS when the source key is malformed", async () => {
      const result = await simulateAccountMerge(
        HORIZON_URL,
        "not-a-stellar-key",
        DEST_KEY,
      );
      expect(result.status).toBe("error");
      if (result.status !== "error") return;
      expect(result.error.code).toBe(SorokitErrorCode.INVALID_ADDRESS);
      expect(result.error.message).toContain("source public key");
    });

    it("returns INVALID_ADDRESS when the destination key is malformed", async () => {
      const result = await simulateAccountMerge(
        HORIZON_URL,
        SOURCE_KEY,
        "XBAD",
      );
      expect(result.status).toBe("error");
      if (result.status !== "error") return;
      expect(result.error.code).toBe(SorokitErrorCode.INVALID_ADDRESS);
      expect(result.error.message).toContain("destination public key");
    });

    it("returns VALIDATION error when source and destination are the same", async () => {
      const result = await simulateAccountMerge(
        HORIZON_URL,
        SOURCE_KEY,
        SOURCE_KEY,
      );
      expect(result.status).toBe("error");
      if (result.status !== "error") return;
      expect(result.error.code).toBe(SorokitErrorCode.VALIDATION);
      expect(result.error.message).toContain("cannot be merged into itself");
    });
  });

  describe("account fetch failures", () => {
    it("returns ACCOUNT_NOT_FOUND when the source account does not exist", async () => {
      mockGetAccount.mockResolvedValueOnce(
        err(SorokitErrorCode.ACCOUNT_NOT_FOUND, "Account not found"),
      );

      const result = await simulateAccountMerge(
        HORIZON_URL,
        SOURCE_KEY,
        DEST_KEY,
      );
      expect(result.status).toBe("error");
      if (result.status !== "error") return;
      expect(result.error.code).toBe(SorokitErrorCode.ACCOUNT_NOT_FOUND);
      expect(result.error.message).toContain("Source account not found");
    });

    it("returns ACCOUNT_FETCH_FAILED when source fetch throws a network error", async () => {
      mockGetAccount.mockResolvedValueOnce(
        err(SorokitErrorCode.ACCOUNT_FETCH_FAILED, "Network error"),
      );

      const result = await simulateAccountMerge(
        HORIZON_URL,
        SOURCE_KEY,
        DEST_KEY,
      );
      expect(result.status).toBe("error");
      if (result.status !== "error") return;
      expect(result.error.code).toBe(SorokitErrorCode.ACCOUNT_FETCH_FAILED);
      expect(result.error.message).toContain("source account");
    });

    it("returns ACCOUNT_NOT_FOUND when the destination account does not exist", async () => {
      // Source succeeds, destination 404
      mockGetAccount
        .mockResolvedValueOnce(ok(makeAccount()))
        .mockResolvedValueOnce(
          err(SorokitErrorCode.ACCOUNT_NOT_FOUND, "Destination not found"),
        );

      const result = await simulateAccountMerge(
        HORIZON_URL,
        SOURCE_KEY,
        DEST_KEY,
      );
      expect(result.status).toBe("error");
      if (result.status !== "error") return;
      expect(result.error.code).toBe(SorokitErrorCode.ACCOUNT_NOT_FOUND);
      expect(result.error.message).toContain("Destination account not found");
    });

    it("returns ACCOUNT_FETCH_FAILED when destination fetch fails", async () => {
      mockGetAccount
        .mockResolvedValueOnce(ok(makeAccount()))
        .mockResolvedValueOnce(
          err(SorokitErrorCode.ACCOUNT_FETCH_FAILED, "Network timeout"),
        );

      const result = await simulateAccountMerge(
        HORIZON_URL,
        SOURCE_KEY,
        DEST_KEY,
      );
      expect(result.status).toBe("error");
      if (result.status !== "error") return;
      expect(result.error.code).toBe(SorokitErrorCode.ACCOUNT_FETCH_FAILED);
    });
  });

  describe("balance & minimum reserve validation", () => {
    it("returns VALIDATION error when source XLM balance is below minimum required", async () => {
      // 2 subentries → min = (2+2)×0.5 = 2.0 XLM; balance is 1 XLM → below
      const sourceWithLowBalance = makeAccount({
        subentryCount: 2,
        balances: [
          {
            assetType: "native",
            assetCode: "XLM",
            assetIssuer: null,
            balance: "1.0000000",
            balanceFloat: 1,
          },
        ],
      });

      mockGetAccount
        .mockResolvedValueOnce(ok(sourceWithLowBalance))
        .mockResolvedValueOnce(ok(makeAccount({ publicKey: DEST_KEY })));

      const result = await simulateAccountMerge(
        HORIZON_URL,
        SOURCE_KEY,
        DEST_KEY,
      );
      expect(result.status).toBe("error");
      if (result.status !== "error") return;
      expect(result.error.code).toBe(SorokitErrorCode.VALIDATION);
      expect(result.error.message).toContain("minimum required balance");
    });
  });

  describe("trustline checks", () => {
    it("returns VALIDATION error when source has non-native trustlines by default", async () => {
      const sourceWithTrustlines = makeAccount({
        subentryCount: 1,
        balances: [
          {
            assetType: "native",
            assetCode: "XLM",
            assetIssuer: null,
            balance: "10.0000000",
            balanceFloat: 10,
          },
          {
            assetType: "credit_alphanum4",
            assetCode: "USDC",
            assetIssuer:
              "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
            balance: "0.0000000",
            balanceFloat: 0,
          },
        ],
      });

      mockGetAccount
        .mockResolvedValueOnce(ok(sourceWithTrustlines))
        .mockResolvedValueOnce(ok(makeAccount({ publicKey: DEST_KEY })));

      const result = await simulateAccountMerge(
        HORIZON_URL,
        SOURCE_KEY,
        DEST_KEY,
      );
      expect(result.status).toBe("error");
      if (result.status !== "error") return;
      expect(result.error.code).toBe(SorokitErrorCode.VALIDATION);
      expect(result.error.message).toContain("trustline");
      expect(result.error.message).toContain("USDC");
    });

    it("succeeds when source has trustlines and allowTrustlines: true", async () => {
      const sourceWithTrustlines = makeAccount({
        subentryCount: 1,
        balances: [
          {
            assetType: "native",
            assetCode: "XLM",
            assetIssuer: null,
            balance: "10.0000000",
            balanceFloat: 10,
          },
          {
            assetType: "credit_alphanum4",
            assetCode: "USDC",
            assetIssuer:
              "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
            balance: "0.0000000",
            balanceFloat: 0,
          },
        ],
      });

      mockGetAccount
        .mockResolvedValueOnce(ok(sourceWithTrustlines))
        .mockResolvedValueOnce(ok(makeAccount({ publicKey: DEST_KEY })));

      const result = await simulateAccountMerge(
        HORIZON_URL,
        SOURCE_KEY,
        DEST_KEY,
        { allowTrustlines: true },
      );
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.data.hasTrustlines).toBe(true);
      expect(result.data.trustlines).toHaveLength(1);
      expect(result.data.trustlines[0]!.assetCode).toBe("USDC");
      expect(result.data.isSafe).toBe(true);
      // Summary should mention trustlines need to be removed
      expect(result.data.summary).toContain("trustline");
    });
  });

  describe("valid merge simulation", () => {
    it("returns a complete simulation report for a safe merge", async () => {
      const source = makeAccount({
        publicKey: SOURCE_KEY,
        subentryCount: 0,
        balances: [
          {
            assetType: "native",
            assetCode: "XLM",
            assetIssuer: null,
            balance: "9.9999900",
            balanceFloat: 9.99999,
          },
        ],
      });
      const dest = makeAccount({ publicKey: DEST_KEY });

      mockGetAccount
        .mockResolvedValueOnce(ok(source))
        .mockResolvedValueOnce(ok(dest));

      const result = await simulateAccountMerge(
        HORIZON_URL,
        SOURCE_KEY,
        DEST_KEY,
      );

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;

      const sim = result.data;
      expect(sim.sourceAccount).toBe(SOURCE_KEY);
      expect(sim.destinationAccount).toBe(DEST_KEY);
      expect(sim.xlmToTransfer).toBe("9.9999900");
      expect(sim.sourceXlmBalance).toBe("9.9999900");
      expect(sim.hasTrustlines).toBe(false);
      expect(sim.trustlines).toHaveLength(0);
      expect(sim.sourceSubentryCount).toBe(0);
      // min = (2+0)×0.5 = 1.0 XLM
      expect(sim.minimumRequiredBalance).toBe("1.0000000");
      expect(sim.destinationExists).toBe(true);
      expect(sim.isSafe).toBe(true);
      expect(sim.summary).toContain("safe to proceed");
    });

    it("passes the signal option to getAccount", async () => {
      const source = makeAccount();
      const dest = makeAccount({ publicKey: DEST_KEY });

      mockGetAccount
        .mockResolvedValueOnce(ok(source))
        .mockResolvedValueOnce(ok(dest));

      const controller = new AbortController();
      await simulateAccountMerge(HORIZON_URL, SOURCE_KEY, DEST_KEY, {
        signal: controller.signal,
      });

      // Both calls should have received the signal
      expect(mockGetAccount).toHaveBeenCalledTimes(2);
      expect(mockGetAccount).toHaveBeenNthCalledWith(
        1,
        HORIZON_URL,
        SOURCE_KEY,
        { signal: controller.signal },
      );
      expect(mockGetAccount).toHaveBeenNthCalledWith(
        2,
        HORIZON_URL,
        DEST_KEY,
        { signal: controller.signal },
      );
    });

    it("calculates minimum balance correctly for accounts with subentries", async () => {
      // subentryCount = 3 → min = (2+3)×0.5 = 2.5 XLM; balance = 5 XLM → ok
      const source = makeAccount({
        subentryCount: 3,
        balances: [
          {
            assetType: "native",
            assetCode: "XLM",
            assetIssuer: null,
            balance: "5.0000000",
            balanceFloat: 5,
          },
        ],
      });
      const dest = makeAccount({ publicKey: DEST_KEY });

      mockGetAccount
        .mockResolvedValueOnce(ok(source))
        .mockResolvedValueOnce(ok(dest));

      const result = await simulateAccountMerge(
        HORIZON_URL,
        SOURCE_KEY,
        DEST_KEY,
        { allowTrustlines: true }, // trustlines allowed for this balance-only test
      );
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.data.minimumRequiredBalance).toBe("2.5000000");
    });
  });
});
