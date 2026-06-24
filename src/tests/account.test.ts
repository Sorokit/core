import { describe, it, expect, vi } from "vitest";
import { formatAddress } from "../shared/utils";
import { streamAccount } from "../account/streamAccount";
import type { AccountInfo } from "../account/types";
import { ok } from "../shared/response";

describe("account", () => {
  describe("formatAddress (pure utility — returns string, not SorokitResult)", () => {
    it("shortens a full public key", () => {
      const key = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      expect(formatAddress(key)).toContain("...");
    });

    it("returns the key unchanged if already short", () => {
      expect(formatAddress("GABCD")).toBe("GABCD");
    });
  });
});

// ── streamAccount balance change hook tests (#11) ─────────────────────────────

function makeAccountInfo(xlmBalance: string, usdcBalance = "0"): AccountInfo {
  return {
    publicKey: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
    displayAddress: "GAAZI...CWNA",
    sequence: "1",
    subentryCount: 0,
    balances: [
      {
        assetType: "native",
        assetCode: "XLM",
        assetIssuer: null,
        balance: xlmBalance,
        balanceFloat: parseFloat(xlmBalance),
      },
      {
        assetType: "credit_alphanum4",
        assetCode: "USDC",
        assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        balance: usdcBalance,
        balanceFloat: parseFloat(usdcBalance),
      },
    ],
  };
}

vi.mock("../account/getAccount", () => ({
  getAccount: vi.fn(),
}));

import { getAccount } from "../account/getAccount";
const mockGetAccount = getAccount as ReturnType<typeof vi.fn>;

describe("streamAccount — onBalanceChange hook (#11)", () => {
  it("fires onBalanceChange when XLM balance changes between polls", async () => {
    mockGetAccount
      .mockResolvedValueOnce(ok(makeAccountInfo("100.0")))
      .mockResolvedValueOnce(ok(makeAccountInfo("90.0")));

    const onBalanceChange = vi.fn();
    const ac = new AbortController();

    let polls = 0;
    for await (const _ of streamAccount(
      "https://horizon-testnet.stellar.org",
      "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
      { intervalMs: 1, maxPolls: 2, onBalanceChange },
      ac.signal,
    )) {
      polls++;
    }

    expect(polls).toBe(2);
    expect(onBalanceChange).toHaveBeenCalledOnce();
    expect(onBalanceChange).toHaveBeenCalledWith("XLM", "100.0", "90.0");
  });

  it("does not fire onBalanceChange when balances are unchanged", async () => {
    mockGetAccount
      .mockResolvedValueOnce(ok(makeAccountInfo("100.0")))
      .mockResolvedValueOnce(ok(makeAccountInfo("100.0")));

    const onBalanceChange = vi.fn();

    for await (const _ of streamAccount(
      "https://horizon-testnet.stellar.org",
      "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
      { intervalMs: 1, maxPolls: 2, onBalanceChange },
    )) { /* consume */ }

    expect(onBalanceChange).not.toHaveBeenCalled();
  });

  it("fires onBalanceChange for multiple changed assets in same poll", async () => {
    mockGetAccount
      .mockResolvedValueOnce(ok(makeAccountInfo("100.0", "50.0")))
      .mockResolvedValueOnce(ok(makeAccountInfo("90.0", "60.0")));

    const onBalanceChange = vi.fn();

    for await (const _ of streamAccount(
      "https://horizon-testnet.stellar.org",
      "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
      { intervalMs: 1, maxPolls: 2, onBalanceChange },
    )) { /* consume */ }

    expect(onBalanceChange).toHaveBeenCalledTimes(2);
    expect(onBalanceChange).toHaveBeenCalledWith("XLM", "100.0", "90.0");
    expect(onBalanceChange).toHaveBeenCalledWith("USDC", "50.0", "60.0");
  });

  it("does not fire onBalanceChange on first poll (no previous state)", async () => {
    mockGetAccount.mockResolvedValueOnce(ok(makeAccountInfo("100.0")));

    const onBalanceChange = vi.fn();

    for await (const _ of streamAccount(
      "https://horizon-testnet.stellar.org",
      "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
      { intervalMs: 1, maxPolls: 1, onBalanceChange },
    )) { /* consume */ }

    expect(onBalanceChange).not.toHaveBeenCalled();
  });

  it("still yields full account state when onBalanceChange is provided", async () => {
    mockGetAccount.mockResolvedValueOnce(ok(makeAccountInfo("100.0")));

    const results = [];
    for await (const result of streamAccount(
      "https://horizon-testnet.stellar.org",
      "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
      { intervalMs: 1, maxPolls: 1, onBalanceChange: vi.fn() },
    )) {
      results.push(result);
    }

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("ok");
    if (results[0]!.status === "ok") {
      expect(results[0]!.data.balances).toHaveLength(2);
    }
  });

  it("works correctly without onBalanceChange (backward compatible)", async () => {
    mockGetAccount
      .mockResolvedValueOnce(ok(makeAccountInfo("100.0")))
      .mockResolvedValueOnce(ok(makeAccountInfo("200.0")));

    const results = [];
    for await (const result of streamAccount(
      "https://horizon-testnet.stellar.org",
      "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
      { intervalMs: 1, maxPolls: 2 },
    )) {
      results.push(result);
    }

    expect(results).toHaveLength(2);
  });
});
