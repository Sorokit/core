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

beforeEach(() => {
  accountMockState.sleepCalls.length = 0;
  accountMockState.index = 0;
  accountMockState.results = [];
});
import { describe, it, expect, vi } from "vitest";
import { formatAddress, deepEqual } from "../shared/utils";

vi.mock("../account/getAccount", () => ({
  getAccount: vi.fn(),
}));

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
        1000,
        1000,
      ]);
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
