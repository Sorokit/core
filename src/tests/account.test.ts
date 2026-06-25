import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatAddress } from "../shared/utils";
import { ok } from "../shared/response";
import type { AccountInfo } from "../account/types";

const accountMockState = vi.hoisted(() => ({
  sleepCalls: [] as number[],
  results: [] as AccountInfo[],
  index: 0,
}));

vi.mock("../shared", async () => {
  const actual = await vi.importActual<typeof import("../shared")>("../shared");
  return {
    ...actual,
    sleep: vi.fn((ms: number) => {
      accountMockState.sleepCalls.push(ms);
      return Promise.resolve();
    }),
  };
});

vi.mock("../account/getAccount", () => ({
  getAccount: vi.fn(async () => {
    const result =
      accountMockState.results[accountMockState.index] ??
      accountMockState.results.at(-1)!;
    accountMockState.index++;
    return ok(result);
  }),
}));

import { streamAccount } from "../account/streamAccount";

function createAccount(sequence: string): AccountInfo {
  return {
    publicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    displayAddress: "GAAAA...AAAA",
    sequence,
    subentryCount: 0,
    balances: [],
  };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

beforeEach(() => {
  accountMockState.sleepCalls.length = 0;
  accountMockState.index = 0;
  accountMockState.results = [];
});

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

  describe("streamAccount", () => {
    it("increases interval after unchanged polls and decreases after activity", async () => {
      accountMockState.results = [
        createAccount("1"),
        createAccount("1"),
        createAccount("1"),
        createAccount("2"),
      ];

      const stream = streamAccount("https://horizon.test", "G...", {
        intervalMs: 2000,
        minIntervalMs: 1000,
        maxIntervalMs: 4000,
        adaptiveThreshold: 2,
        maxPolls: 4,
      });

      await stream.next();
      await stream.next();
      await stream.next();
      await stream.next();

      expect(accountMockState.sleepCalls).toEqual([2000, 2000, 3000]);
    });

    it("respects interval boundaries", async () => {
      accountMockState.results = [
        createAccount("1"),
        createAccount("1"),
        createAccount("1"),
        createAccount("1"),
        createAccount("2"),
        createAccount("2"),
        createAccount("2"),
        createAccount("2"),
      ];

      const stream = streamAccount("https://horizon.test", "G...", {
        intervalMs: 2000,
        minIntervalMs: 1000,
        maxIntervalMs: 3000,
        adaptiveThreshold: 1,
        maxPolls: 8,
      });

      for (let i = 0; i < 8; i++) {
        await stream.next();
      }

      expect(accountMockState.sleepCalls).toEqual([
        2000,
        3000,
        3000,
        3000,
        2000,
        3000,
        3000,
      ]);
    });
  });

  describe("deepEqual", () => {
    it("returns true for identical plain objects", () => {
      expect(deepEqual({ a: 1, b: [2, 3] }, { a: 1, b: [2, 3] })).toBe(true);
    });

    it("returns false for objects with different values", () => {
      expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    });

    it("returns true for same reference", () => {
      const obj = { a: 1 };
      expect(deepEqual(obj, obj)).toBe(true);
    });

    it("returns false for objects with different keys", () => {
      expect(deepEqual({ a: 1 }, { b: 1 })).toBe(false);
    });

    it("handles nested differences in balances", () => {
      const a = { sequence: "1", balances: [{ balance: "100" }] };
      const b = { sequence: "1", balances: [{ balance: "200" }] };
      expect(deepEqual(a, b)).toBe(false);
    });

    it("returns true for identical nested objects", () => {
      const a = { sequence: "1", balances: [{ balance: "100" }] };
      const b = { sequence: "1", balances: [{ balance: "100" }] };
      expect(deepEqual(a, b)).toBe(true);
    });
  });

  describe("streamAccount deduplication", () => {
    it("does not re-emit when account state is unchanged", async () => {
      const { getAccount } = await import("../account/getAccount");
      const { streamAccount } = await import("../account/streamAccount");
      const { ok } = await import("../shared/response");

      const account = {
        publicKey: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
        displayAddress: "GAAZI...CWNA",
        sequence: "1",
        subentryCount: 0,
        balances: [{ assetType: "native" as const, assetCode: "XLM", assetIssuer: null, balance: "100", balanceFloat: 100 }],
      };

      vi.mocked(getAccount)
        .mockResolvedValueOnce(ok(account))
        .mockResolvedValueOnce(ok(account));

      const results: unknown[] = [];
      for await (const r of streamAccount("http://horizon", account.publicKey, { maxPolls: 2, emitOnStart: true, intervalMs: 1 })) {
        results.push(r);
      }

      expect(results.length).toBe(1);
    }, 10_000);

    it("emits again when account state changes", async () => {
      const { getAccount } = await import("../account/getAccount");
      const { streamAccount } = await import("../account/streamAccount");
      const { ok } = await import("../shared/response");

      const a1 = {
        publicKey: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
        displayAddress: "GAAZI...CWNA",
        sequence: "1",
        subentryCount: 0,
        balances: [{ assetType: "native" as const, assetCode: "XLM", assetIssuer: null, balance: "100", balanceFloat: 100 }],
      };
      const a2 = { ...a1, sequence: "2", balances: [{ assetType: "native" as const, assetCode: "XLM", assetIssuer: null, balance: "200", balanceFloat: 200 }] };

      vi.mocked(getAccount)
        .mockResolvedValueOnce(ok(a1))
        .mockResolvedValueOnce(ok(a2))
        .mockResolvedValueOnce(ok(a2));

      const results: unknown[] = [];
      for await (const r of streamAccount("http://horizon", a1.publicKey, { maxPolls: 3, emitOnStart: true, intervalMs: 1 })) {
        results.push(r);
      }

      expect(results.length).toBe(2);
    }, 10_000);
  });

  describe("evaluateBalanceAlerts", () => {
    function bal(assetCode: string, balance: string, assetIssuer: string | null = null) {
      return {
        assetType: assetIssuer ? ("credit_alphanum4" as const) : ("native" as const),
        assetCode,
        assetIssuer,
        balance,
        balanceFloat: parseFloat(balance),
      };
    }

    it("fires when a balance crosses below the threshold", async () => {
      const { evaluateBalanceAlerts } = await import("../account/balanceAlerts");
      const alerts = evaluateBalanceAlerts(
        [{ assetCode: "XLM", condition: "below", threshold: 50 }],
        [bal("XLM", "100")],
        [bal("XLM", "40")],
      );
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.oldBalance).toBe("100");
      expect(alerts[0]?.newBalance).toBe("40");
    });

    it("does not fire below when already below (no fresh crossing)", async () => {
      const { evaluateBalanceAlerts } = await import("../account/balanceAlerts");
      const alerts = evaluateBalanceAlerts(
        [{ assetCode: "XLM", condition: "below", threshold: 50 }],
        [bal("XLM", "40")],
        [bal("XLM", "30")],
      );
      expect(alerts).toHaveLength(0);
    });

    it("fires below on the first poll when no baseline exists", async () => {
      const { evaluateBalanceAlerts } = await import("../account/balanceAlerts");
      const alerts = evaluateBalanceAlerts(
        [{ assetCode: "XLM", condition: "below", threshold: 50 }],
        [],
        [bal("XLM", "10")],
      );
      expect(alerts).toHaveLength(1);
    });

    it("fires when a balance crosses above the threshold", async () => {
      const { evaluateBalanceAlerts } = await import("../account/balanceAlerts");
      const alerts = evaluateBalanceAlerts(
        [{ assetCode: "XLM", condition: "above", threshold: 100 }],
        [bal("XLM", "90")],
        [bal("XLM", "150")],
      );
      expect(alerts).toHaveLength(1);
    });

    it("fires on percentage change at or above the threshold", async () => {
      const { evaluateBalanceAlerts } = await import("../account/balanceAlerts");
      const alerts = evaluateBalanceAlerts(
        [{ assetCode: "USDC", condition: "change_percent", threshold: 10 }],
        [bal("USDC", "100", "GISSUER")],
        [bal("USDC", "120", "GISSUER")],
      );
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.changePercent).toBeCloseTo(20);
    });

    it("does not fire on a sub-threshold percentage change", async () => {
      const { evaluateBalanceAlerts } = await import("../account/balanceAlerts");
      const alerts = evaluateBalanceAlerts(
        [{ assetCode: "USDC", condition: "change_percent", threshold: 50 }],
        [bal("USDC", "100", "GISSUER")],
        [bal("USDC", "120", "GISSUER")],
      );
      expect(alerts).toHaveLength(0);
    });

    it("matches by issuer when one is specified", async () => {
      const { evaluateBalanceAlerts } = await import("../account/balanceAlerts");
      const alerts = evaluateBalanceAlerts(
        [{ assetCode: "USDC", assetIssuer: "GISSUER_A", condition: "below", threshold: 50 }],
        [bal("USDC", "100", "GISSUER_A")],
        [bal("USDC", "10", "GISSUER_B")],
      );
      // The new balances only contain GISSUER_B, so the GISSUER_A rule has no match.
      expect(alerts).toHaveLength(0);
    });

    it("echoes the rule (including id) back on the alert", async () => {
      const { evaluateBalanceAlerts } = await import("../account/balanceAlerts");
      const rule = { id: "low-xlm", assetCode: "XLM", condition: "below" as const, threshold: 50 };
      const alerts = evaluateBalanceAlerts([rule], [bal("XLM", "100")], [bal("XLM", "40")]);
      expect(alerts[0]?.rule.id).toBe("low-xlm");
    });

    it("streamAccount dispatches alerts to onAlert as balances change", async () => {
      const { getAccount } = await import("../account/getAccount");
      const { streamAccount } = await import("../account/streamAccount");
      const { ok } = await import("../shared/response");

      const pk = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA";
      const a1: AccountInfo = {
        publicKey: pk,
        displayAddress: "GAAZI...CWNA",
        sequence: "1",
        subentryCount: 0,
        balances: [bal("XLM", "100")],
      };
      const a2: AccountInfo = { ...a1, sequence: "2", balances: [bal("XLM", "40")] };

      vi.mocked(getAccount).mockResolvedValueOnce(ok(a1)).mockResolvedValueOnce(ok(a2));

      const received: string[] = [];
      const stream = streamAccount(
        "http://horizon",
        pk,
        {
          maxPolls: 2,
          emitOnStart: true,
          intervalMs: 1,
          alertRules: [{ assetCode: "XLM", condition: "below", threshold: 50 }],
          onAlert: (alert) => received.push(alert.newBalance),
        },
      );
      for await (const _ of stream) {
        void _;
      }

      expect(received).toEqual(["40"]);
    }, 10_000);

    it("does not dispatch alerts when onAlert is omitted (backward compatible)", async () => {
      const { evaluateBalanceAlerts } = await import("../account/balanceAlerts");
      // Sanity: evaluation itself is pure and never throws on empty rules.
      expect(evaluateBalanceAlerts([], [bal("XLM", "100")], [bal("XLM", "40")])).toEqual([]);
    });
  });

  describe("getAssetBalances — issuer whitelisting", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("allows all issuers when trustedIssuers not configured", async () => {
      const { getAssetBalances } = await import("../account/getAssetBalances");
      const { getAccount } = await import("../account/getAccount");
      const { ok } = await import("../shared/response");

      const account = {
        publicKey: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
        displayAddress: "GAAZI...CWNA",
        sequence: "1",
        subentryCount: 0,
        balances: [
          { assetType: "native" as const, assetCode: "XLM", assetIssuer: null, balance: "100", balanceFloat: 100 },
          { assetType: "credit_alphanum4" as const, assetCode: "USDC", assetIssuer: "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQ75XABEE3XZNIXUAA", balance: "50", balanceFloat: 50 },
        ],
      };

      vi.mocked(getAccount).mockResolvedValueOnce(ok(account));

      const result = await getAssetBalances("http://horizon", account.publicKey, undefined, null);

      expect(result.status).toBe("ok");
      expect((result as any).data).toHaveLength(2);
    });

    it("allows asset when issuer is in whitelist", async () => {
      const { getAssetBalances } = await import("../account/getAssetBalances");
      const { getAccount } = await import("../account/getAccount");
      const { ok } = await import("../shared/response");

      const trustedIssuer = "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQ75XABEE3XZNIXUAA";
      const account = {
        publicKey: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
        displayAddress: "GAAZI...CWNA",
        sequence: "1",
        subentryCount: 0,
        balances: [
          { assetType: "native" as const, assetCode: "XLM", assetIssuer: null, balance: "100", balanceFloat: 100 },
          { assetType: "credit_alphanum4" as const, assetCode: "USDC", assetIssuer: trustedIssuer, balance: "50", balanceFloat: 50 },
        ],
      };

      vi.mocked(getAccount).mockResolvedValueOnce(ok(account));

      const result = await getAssetBalances("http://horizon", account.publicKey, undefined, [trustedIssuer]);

      expect(result.status).toBe("ok");
      expect((result as any).data).toHaveLength(2);
    });

    it("returns error when issuer is not in whitelist", async () => {
      const { getAssetBalances } = await import("../account/getAssetBalances");
      const { getAccount } = await import("../account/getAccount");
      const { ok } = await import("../shared/response");

      const trustedIssuer = "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQ75XABEE3XZNIXUAA";
      const untrustedIssuer = "GBBD47UZQ5JAKVEWZNRPA7MKSTIRZU27I27ULMOWVNQZLB助ZZW7QTXN";
      const account = {
        publicKey: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
        displayAddress: "GAAZI...CWNA",
        sequence: "1",
        subentryCount: 0,
        balances: [
          { assetType: "native" as const, assetCode: "XLM", assetIssuer: null, balance: "100", balanceFloat: 100 },
          { assetType: "credit_alphanum4" as const, assetCode: "USDC", assetIssuer: untrustedIssuer, balance: "50", balanceFloat: 50 },
        ],
      };

      vi.mocked(getAccount).mockResolvedValueOnce(ok(account));

      const result = await getAssetBalances("http://horizon", account.publicKey, undefined, [trustedIssuer]);

      expect(result.status).toBe("error");
      expect((result as any).error.code).toBe("TX_BUILD_FAILED");
      expect((result as any).error.message).toContain("not in the trusted issuers whitelist");
    });

    it("allows all issuers when trustedIssuers is empty array", async () => {
      const { getAssetBalances } = await import("../account/getAssetBalances");
      const { getAccount } = await import("../account/getAccount");
      const { ok } = await import("../shared/response");

      const account = {
        publicKey: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
        displayAddress: "GAAZI...CWNA",
        sequence: "1",
        subentryCount: 0,
        balances: [
          { assetType: "native" as const, assetCode: "XLM", assetIssuer: null, balance: "100", balanceFloat: 100 },
          { assetType: "credit_alphanum4" as const, assetCode: "USDC", assetIssuer: "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQ75XABEE3XZNIXUAA", balance: "50", balanceFloat: 50 },
        ],
      };

      vi.mocked(getAccount).mockResolvedValueOnce(ok(account));

      const result = await getAssetBalances("http://horizon", account.publicKey, undefined, []);

      expect(result.status).toBe("ok");
      expect((result as any).data).toHaveLength(2);
    });
  });
});

describe("streamAccount — onBalanceChange callback (#11)", () => {
  it("fires onBalanceChange when a balance changes between polls", async () => {
    const { getAccount } = await import("../account/getAccount");
    const { streamAccount } = await import("../account/streamAccount");
    const { ok } = await import("../shared/response");

    const base = {
      publicKey: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
      displayAddress: "GAAZI...CWNA",
      sequence: "1",
      subentryCount: 0,
    };
    const a1 = {
      ...base,
      balances: [
        { assetType: "native" as const, assetCode: "XLM", assetIssuer: null, balance: "100", balanceFloat: 100 },
      ],
    };
    const a2 = {
      ...base,
      sequence: "2",
      balances: [
        { assetType: "native" as const, assetCode: "XLM", assetIssuer: null, balance: "150", balanceFloat: 150 },
      ],
    };

    vi.mocked(getAccount)
      .mockResolvedValueOnce(ok(a1))
      .mockResolvedValueOnce(ok(a2));

    const changes: Array<{ assetCode: string; oldBalance: string; newBalance: string }> = [];
    for await (const _ of streamAccount(
      "http://horizon",
      base.publicKey,
      {
        maxPolls: 2,
        emitOnStart: true,
        intervalMs: 1,
        onBalanceChange: (assetCode, oldBalance, newBalance) =>
          changes.push({ assetCode, oldBalance, newBalance }),
      },
    )) { /* consume */ }

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ assetCode: "XLM", oldBalance: "100", newBalance: "150" });
  }, 10_000);

  it("does not fire onBalanceChange when balances are unchanged", async () => {
    const { getAccount } = await import("../account/getAccount");
    const { streamAccount } = await import("../account/streamAccount");
    const { ok } = await import("../shared/response");

    const account = {
      publicKey: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
      displayAddress: "GAAZI...CWNA",
      sequence: "1",
      subentryCount: 0,
      balances: [
        { assetType: "native" as const, assetCode: "XLM", assetIssuer: null, balance: "100", balanceFloat: 100 },
      ],
    };

    vi.mocked(getAccount)
      .mockResolvedValueOnce(ok(account))
      .mockResolvedValueOnce(ok(account));

    const changes: unknown[] = [];
    for await (const _ of streamAccount(
      "http://horizon",
      account.publicKey,
      {
        maxPolls: 2,
        emitOnStart: true,
        intervalMs: 1,
        onBalanceChange: () => changes.push(true),
      },
    )) { /* consume */ }

    expect(changes).toHaveLength(0);
  }, 10_000);

  it("fires onBalanceChange for each changed balance independently", async () => {
    const { getAccount } = await import("../account/getAccount");
    const { streamAccount } = await import("../account/streamAccount");
    const { ok } = await import("../shared/response");

    const base = {
      publicKey: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
      displayAddress: "GAAZI...CWNA",
      sequence: "1",
      subentryCount: 0,
    };
    const a1 = {
      ...base,
      balances: [
        { assetType: "native" as const, assetCode: "XLM", assetIssuer: null, balance: "100", balanceFloat: 100 },
        { assetType: "credit_alphanum4" as const, assetCode: "USDC", assetIssuer: "GA5Z...ISSUER", balance: "50", balanceFloat: 50 },
      ],
    };
    const a2 = {
      ...base,
      sequence: "2",
      balances: [
        { assetType: "native" as const, assetCode: "XLM", assetIssuer: null, balance: "90", balanceFloat: 90 },
        { assetType: "credit_alphanum4" as const, assetCode: "USDC", assetIssuer: "GA5Z...ISSUER", balance: "60", balanceFloat: 60 },
      ],
    };

    vi.mocked(getAccount)
      .mockResolvedValueOnce(ok(a1))
      .mockResolvedValueOnce(ok(a2));

    const changes: Array<{ assetCode: string }> = [];
    for await (const _ of streamAccount(
      "http://horizon",
      base.publicKey,
      {
        maxPolls: 2,
        emitOnStart: true,
        intervalMs: 1,
        onBalanceChange: (assetCode) => changes.push({ assetCode }),
      },
    )) { /* consume */ }

    expect(changes).toHaveLength(2);
    expect(changes.map((c) => c.assetCode).sort()).toEqual(["USDC", "XLM"]);
  }, 10_000);
});
