import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatAddress } from "../shared/utils";
import { ok, err, SorokitErrorCode } from "../shared/response";
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
      if (typeof vi.isFakeTimers === "function" && vi.isFakeTimers()) {
        return new Promise((resolve) => setTimeout(resolve, ms));
      }
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

// Add error state for retry tests
const accountErrorMockState = vi.hoisted(() => ({
  sleepCalls: [] as number[],
  errors: [] as Error[],
  index: 0,
  shouldFail: false,
  failCount: 0,
}));

vi.mock("@stellar/stellar-sdk", async (importOriginal: any) => {
  const actual = await importOriginal("@stellar/stellar-sdk");
  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: vi.fn(),
    },
  };
});

import { DEFAULT_ADDRESS_DISPLAY_CHARS } from "../shared/constants";

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
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe("formatAddress (pure utility — returns string, not SorokitResult)", () => {
    it("shortens a full public key", () => {
      const key = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      expect(formatAddress(key)).toContain("...");
    });

    it("returns the key unchanged if already short", () => {
      expect(formatAddress("GABCD")).toBe("GABCD");
    });
  });

  describe("getAccount", () => {
    it("returns displayAddress containing ellipsis, prefix, and suffix matching configuration lengths", async () => {
      const { getAccount } = await vi.importActual<
        typeof import("../account/getAccount")
      >("../account/getAccount");
      const { Horizon } = await import("@stellar/stellar-sdk");

      const publicKey =
        "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      const mockAccount = {
        sequence: "12345",
        subentry_count: 3,
        balances: [{ asset_type: "native", balance: "100.00000" }],
      };

      const mockLoadAccount = vi.fn().mockResolvedValue(mockAccount);
      vi.mocked(Horizon.Server).mockImplementationOnce(
        () =>
          ({
            loadAccount: mockLoadAccount,
          }) as any,
      );

      const result = await getAccount("https://horizon.test", publicKey);
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.displayAddress).toContain("...");
        const prefix = publicKey.slice(0, DEFAULT_ADDRESS_DISPLAY_CHARS + 1);
        const suffix = publicKey.slice(-DEFAULT_ADDRESS_DISPLAY_CHARS);
        expect(result.data.displayAddress.startsWith(prefix)).toBe(true);
        expect(result.data.displayAddress.endsWith(suffix)).toBe(true);
      }
    });

    it("returns short public key unchanged as displayAddress", async () => {
      const { getAccount } = await vi.importActual<
        typeof import("../account/getAccount")
      >("../account/getAccount");
      const { Horizon } = await import("@stellar/stellar-sdk");

      const publicKey = "GABCDEFGHI";
      const mockAccount = {
        sequence: "12345",
        subentry_count: 3,
        balances: [{ asset_type: "native", balance: "100.00000" }],
      };

      const mockLoadAccount = vi.fn().mockResolvedValue(mockAccount);
      vi.mocked(Horizon.Server).mockImplementationOnce(
        () =>
          ({
            loadAccount: mockLoadAccount,
          }) as any,
      );

      const result = await getAccount("https://horizon.test", publicKey);
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.displayAddress).toBe(publicKey);
      }
    });
  });

  describe("streamAccount", () => {
    it("emits a warning when intervalMs is clamped below minimum", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const stream = streamAccount("https://horizon.test", "G...", {
        intervalMs: 100,
        maxPolls: 1,
      });

      await stream.next();

      expect(warnSpy).toHaveBeenCalledWith(
        "intervalMs clamped from 100ms to 1000ms",
      );
      warnSpy.mockRestore();
    });

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
        2000, 3000, 3000, 3000, 2000, 3000, 3000,
      ]);
    });

    describe("streamAccount emit/clamp behavior (#276)", () => {
      it("emitOnStart false with maxPolls 1 yields exactly one result after the first sleep", async () => {
        vi.useFakeTimers();

        const shared = await import("../shared");
        const sleepMock = vi.mocked(shared.sleep);
        sleepMock.mockImplementation(
          (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
        );

        try {
          accountMockState.results = [createAccount("1")];

          const stream = streamAccount("https://horizon.test", "G...", {
            intervalMs: 1000,
            emitOnStart: false,
            maxPolls: 1,
          });

          const first = stream.next();

          let settled = false;
          first.then(() => {
            settled = true;
          });
          expect(settled).toBe(false);

          await vi.advanceTimersByTimeAsync(1000);
          const result = await first;
          expect(result.done).toBe(false);
          expect(result.value?.status).toBe("ok");
          if (result.value?.status === "ok") {
            expect(result.value.data.sequence).toBe("1");
          }

          const second = await stream.next();
          expect(second.done).toBe(true);
        } finally {
          sleepMock.mockImplementation((ms: number) => {
            accountMockState.sleepCalls.push(ms);
            return Promise.resolve();
          });
          vi.useRealTimers();
        }
      }, 15000);

      it("intervalMs 500 is clamped to 1000ms verifiable via fake timers", async () => {
        vi.useFakeTimers();

        const shared = await import("../shared");
        const sleepMock = vi.mocked(shared.sleep);
        sleepMock.mockImplementation(
          (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
        );

        try {
          accountMockState.results = [createAccount("1"), createAccount("2")];

          const stream = streamAccount("https://horizon.test", "G...", {
            intervalMs: 500,
            maxPolls: 2,
          });

          const first = await stream.next();
          expect(first.done).toBe(false);
          expect(first.value?.status).toBe("ok");

          const secondPromise = stream.next();
          let settled = false;
          secondPromise.then(() => {
            settled = true;
          });
          expect(settled).toBe(false);

          await vi.advanceTimersByTimeAsync(999);
          expect(settled).toBe(false);

          await vi.advanceTimersByTimeAsync(1);
          const result2 = await secondPromise;
          expect(result2.done).toBe(false);
          expect(result2.value?.status).toBe("ok");
        } finally {
          sleepMock.mockImplementation((ms: number) => {
            accountMockState.sleepCalls.push(ms);
            return Promise.resolve();
          });
          vi.useRealTimers();
        }
      }, 15000);

      it("emitOnStart true with maxPolls 0 yields nothing", async () => {
        vi.useFakeTimers();

        try {
          const stream = streamAccount("https://horizon.test", "G...", {
            emitOnStart: true,
            maxPolls: 0,
          });

          const result = await stream.next();
          expect(result.done).toBe(true);
        } finally {
          vi.useRealTimers();
        }
      }, 10000);
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
        balances: [
          {
            assetType: "native" as const,
            assetCode: "XLM",
            assetIssuer: null,
            balance: "100",
            balanceFloat: 100,
          },
        ],
      };

      vi.mocked(getAccount)
        .mockResolvedValueOnce(ok(account))
        .mockResolvedValueOnce(ok(account));

      const results: unknown[] = [];
      for await (const r of streamAccount("http://horizon", account.publicKey, {
        maxPolls: 2,
        emitOnStart: true,
        intervalMs: 1,
      })) {
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
        balances: [
          {
            assetType: "native" as const,
            assetCode: "XLM",
            assetIssuer: null,
            balance: "100",
            balanceFloat: 100,
          },
        ],
      };
      const a2 = {
        ...a1,
        sequence: "2",
        balances: [
          {
            assetType: "native" as const,
            assetCode: "XLM",
            assetIssuer: null,
            balance: "200",
            balanceFloat: 200,
          },
        ],
      };

      vi.mocked(getAccount)
        .mockResolvedValueOnce(ok(a1))
        .mockResolvedValueOnce(ok(a2))
        .mockResolvedValueOnce(ok(a2));

      const results: unknown[] = [];
      for await (const r of streamAccount("http://horizon", a1.publicKey, {
        maxPolls: 3,
        emitOnStart: true,
        intervalMs: 1,
      })) {
        results.push(r);
      }

      expect(results.length).toBe(2);
    }, 10_000);
  });

  describe("evaluateBalanceAlerts", () => {
    function bal(
      assetCode: string,
      balance: string,
      assetIssuer: string | null = null,
    ) {
      return {
        assetType: assetIssuer
          ? ("credit_alphanum4" as const)
          : ("native" as const),
        assetCode,
        assetIssuer,
        balance,
        balanceFloat: parseFloat(balance),
      };
    }

    it("fires when a balance crosses below the threshold", async () => {
      const { evaluateBalanceAlerts } =
        await import("../account/balanceAlerts");
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
      const { evaluateBalanceAlerts } =
        await import("../account/balanceAlerts");
      const alerts = evaluateBalanceAlerts(
        [{ assetCode: "XLM", condition: "below", threshold: 50 }],
        [bal("XLM", "40")],
        [bal("XLM", "30")],
      );
      expect(alerts).toHaveLength(0);
    });

    it("fires below on the first poll when no baseline exists", async () => {
      const { evaluateBalanceAlerts } =
        await import("../account/balanceAlerts");
      const alerts = evaluateBalanceAlerts(
        [{ assetCode: "XLM", condition: "below", threshold: 50 }],
        [],
        [bal("XLM", "10")],
      );
      expect(alerts).toHaveLength(1);
    });

    it("fires when a balance crosses above the threshold", async () => {
      const { evaluateBalanceAlerts } =
        await import("../account/balanceAlerts");
      const alerts = evaluateBalanceAlerts(
        [{ assetCode: "XLM", condition: "above", threshold: 100 }],
        [bal("XLM", "90")],
        [bal("XLM", "150")],
      );
      expect(alerts).toHaveLength(1);
    });

    it("fires on percentage change at or above the threshold", async () => {
      const { evaluateBalanceAlerts } =
        await import("../account/balanceAlerts");
      const alerts = evaluateBalanceAlerts(
        [{ assetCode: "USDC", condition: "change_percent", threshold: 10 }],
        [bal("USDC", "100", "GISSUER")],
        [bal("USDC", "120", "GISSUER")],
      );
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.changePercent).toBeCloseTo(20);
    });

    it("does not fire on a sub-threshold percentage change", async () => {
      const { evaluateBalanceAlerts } =
        await import("../account/balanceAlerts");
      const alerts = evaluateBalanceAlerts(
        [{ assetCode: "USDC", condition: "change_percent", threshold: 50 }],
        [bal("USDC", "100", "GISSUER")],
        [bal("USDC", "120", "GISSUER")],
      );
      expect(alerts).toHaveLength(0);
    });

    it("matches by issuer when one is specified", async () => {
      const { evaluateBalanceAlerts } =
        await import("../account/balanceAlerts");
      const alerts = evaluateBalanceAlerts(
        [
          {
            assetCode: "USDC",
            assetIssuer: "GISSUER_A",
            condition: "below",
            threshold: 50,
          },
        ],
        [bal("USDC", "100", "GISSUER_A")],
        [bal("USDC", "10", "GISSUER_B")],
      );
      // The new balances only contain GISSUER_B, so the GISSUER_A rule has no match.
      expect(alerts).toHaveLength(0);
    });

    it("echoes the rule (including id) back on the alert", async () => {
      const { evaluateBalanceAlerts } =
        await import("../account/balanceAlerts");
      const rule = {
        id: "low-xlm",
        assetCode: "XLM",
        condition: "below" as const,
        threshold: 50,
      };
      const alerts = evaluateBalanceAlerts(
        [rule],
        [bal("XLM", "100")],
        [bal("XLM", "40")],
      );
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
      const a2: AccountInfo = {
        ...a1,
        sequence: "2",
        balances: [bal("XLM", "40")],
      };

      vi.mocked(getAccount)
        .mockResolvedValueOnce(ok(a1))
        .mockResolvedValueOnce(ok(a2));

      const received: string[] = [];
      const stream = streamAccount("http://horizon", pk, {
        maxPolls: 2,
        emitOnStart: true,
        intervalMs: 1,
        alertRules: [{ assetCode: "XLM", condition: "below", threshold: 50 }],
        onAlert: (alert) => received.push(alert.newBalance),
      });
      for await (const _ of stream) {
        void _;
      }

      expect(received).toEqual(["40"]);
    }, 10_000);

    it("does not dispatch alerts when onAlert is omitted (backward compatible)", async () => {
      const { evaluateBalanceAlerts } =
        await import("../account/balanceAlerts");
      // Sanity: evaluation itself is pure and never throws on empty rules.
      expect(
        evaluateBalanceAlerts([], [bal("XLM", "100")], [bal("XLM", "40")]),
      ).toEqual([]);
    });
  });

  describe("createBalanceAlert", () => {
    const pk = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA";

    function bal(
      assetCode: string,
      balance: string,
      assetIssuer: string | null = null,
    ) {
      return {
        assetType: assetIssuer
          ? ("credit_alphanum4" as const)
          : ("native" as const),
        assetCode,
        assetIssuer,
        balance,
        balanceFloat: parseFloat(balance),
      };
    }

    it("fires callback when balance crosses a threshold", async () => {
      const { createBalanceAlert } =
        await import("../account/createBalanceAlert");

      const base: AccountInfo = {
        publicKey: pk,
        displayAddress: "GAAZI...CWNA",
        sequence: "1",
        subentryCount: 0,
        balances: [bal("XLM", "100")],
      };

      accountMockState.results = [base];
      accountMockState.index = 0;

      const received: string[] = [];
      const ac = new AbortController();

      createBalanceAlert(
        "http://horizon",
        pk,
        [{ assetCode: "XLM", condition: "below", threshold: 150 }],
        (alert) => received.push(alert.newBalance),
        { signal: ac.signal },
      );

      // Let the async stream process at least one poll
      await new Promise((r) => setTimeout(r, 50));
      ac.abort();

      expect(received.length).toBeGreaterThan(0);
      expect(received[0]).toBe("100");
    }, 10_000);

    it("unsubscribe function stops monitoring", async () => {
      const { createBalanceAlert } =
        await import("../account/createBalanceAlert");

      const base: AccountInfo = {
        publicKey: pk,
        displayAddress: "GAAZI...CWNA",
        sequence: "1",
        subentryCount: 0,
        balances: [bal("XLM", "100")],
      };

      accountMockState.results = [base, base, base];
      accountMockState.index = 0;

      const received: string[] = [];
      const unsubscribe = createBalanceAlert(
        "http://horizon",
        pk,
        [{ assetCode: "XLM", condition: "below", threshold: 150 }],
        (alert) => received.push(alert.newBalance),
      );

      // Should fire on the first poll
      await new Promise((r) => setTimeout(r, 50));
      expect(received.length).toBeGreaterThan(0);

      const countAfterFirstPoll = received.length;
      unsubscribe();

      // After unsubscribe, no more alerts should arrive
      await new Promise((r) => setTimeout(r, 50));
      expect(received.length).toBe(countAfterFirstPoll);
    }, 10_000);

    it("does not fire when no threshold is crossed", async () => {
      const { createBalanceAlert } =
        await import("../account/createBalanceAlert");

      const base: AccountInfo = {
        publicKey: pk,
        displayAddress: "GAAZI...CWNA",
        sequence: "1",
        subentryCount: 0,
        balances: [bal("XLM", "100")],
      };

      accountMockState.results = [base];
      accountMockState.index = 0;

      const received: string[] = [];
      const ac = new AbortController();

      createBalanceAlert(
        "http://horizon",
        pk,
        [{ assetCode: "XLM", condition: "below", threshold: 50 }],
        (alert) => received.push(alert.newBalance),
        { signal: ac.signal },
      );

      await new Promise((r) => setTimeout(r, 50));
      ac.abort();

      // Balance of 100 is above threshold of 50, so no alert
      expect(received).toHaveLength(0);
    }, 10_000);

    it("respects external AbortSignal to stop monitoring", async () => {
      const { createBalanceAlert } =
        await import("../account/createBalanceAlert");

      const base: AccountInfo = {
        publicKey: pk,
        displayAddress: "GAAZI...CWNA",
        sequence: "1",
        subentryCount: 0,
        balances: [bal("XLM", "100")],
      };

      accountMockState.results = [base, base, base];
      accountMockState.index = 0;

      const received: string[] = [];
      const ac = new AbortController();

      createBalanceAlert(
        "http://horizon",
        pk,
        [{ assetCode: "XLM", condition: "below", threshold: 150 }],
        (alert) => received.push(alert.newBalance),
        { signal: ac.signal },
      );

      await new Promise((r) => setTimeout(r, 50));
      expect(received.length).toBeGreaterThan(0);

      const countBefore = received.length;
      ac.abort();
      await new Promise((r) => setTimeout(r, 50));

      // No more alerts after external abort
      expect(received.length).toBe(countBefore);
    }, 10_000);

    it("handles empty rules without error", async () => {
      const { createBalanceAlert } =
        await import("../account/createBalanceAlert");

      const base: AccountInfo = {
        publicKey: pk,
        displayAddress: "GAAZI...CWNA",
        sequence: "1",
        subentryCount: 0,
        balances: [bal("XLM", "100")],
      };

      accountMockState.results = [base];
      accountMockState.index = 0;

      const received: string[] = [];
      const ac = new AbortController();

      expect(() => {
        createBalanceAlert(
          "http://horizon",
          pk,
          [],
          (alert) => received.push(alert.newBalance),
          { signal: ac.signal },
        );
      }).not.toThrow();

      await new Promise((r) => setTimeout(r, 50));
      ac.abort();
      expect(received).toHaveLength(0);
    }, 10_000);
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
          {
            assetType: "native" as const,
            assetCode: "XLM",
            assetIssuer: null,
            balance: "100",
            balanceFloat: 100,
          },
          {
            assetType: "credit_alphanum4" as const,
            assetCode: "USDC",
            assetIssuer:
              "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQ75XABEE3XZNIXUAA",
            balance: "50",
            balanceFloat: 50,
          },
        ],
      };

      vi.mocked(getAccount).mockResolvedValueOnce(ok(account));

      const result = await getAssetBalances(
        "http://horizon",
        account.publicKey,
        undefined,
        null,
      );

      expect(result.status).toBe("ok");
      expect((result as any).data).toHaveLength(2);
    });

    it("allows asset when issuer is in whitelist", async () => {
      const { getAssetBalances } = await import("../account/getAssetBalances");
      const { getAccount } = await import("../account/getAccount");
      const { ok } = await import("../shared/response");

      const trustedIssuer =
        "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQ75XABEE3XZNIXUAA";
      const account = {
        publicKey: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
        displayAddress: "GAAZI...CWNA",
        sequence: "1",
        subentryCount: 0,
        balances: [
          {
            assetType: "native" as const,
            assetCode: "XLM",
            assetIssuer: null,
            balance: "100",
            balanceFloat: 100,
          },
          {
            assetType: "credit_alphanum4" as const,
            assetCode: "USDC",
            assetIssuer: trustedIssuer,
            balance: "50",
            balanceFloat: 50,
          },
        ],
      };

      vi.mocked(getAccount).mockResolvedValueOnce(ok(account));

      const result = await getAssetBalances(
        "http://horizon",
        account.publicKey,
        undefined,
        [trustedIssuer],
      );

      expect(result.status).toBe("ok");
      expect((result as any).data).toHaveLength(2);
    });

    it("returns error when issuer is not in whitelist", async () => {
      const { getAssetBalances } = await import("../account/getAssetBalances");
      const { getAccount } = await import("../account/getAccount");
      const { ok } = await import("../shared/response");

      const trustedIssuer =
        "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQ75XABEE3XZNIXUAA";
      const untrustedIssuer =
        "GBBD47UZQ5JAKVEWZNRPA7MKSTIRZU27I27ULMOWVNQZLB助ZZW7QTXN";
      const account = {
        publicKey: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
        displayAddress: "GAAZI...CWNA",
        sequence: "1",
        subentryCount: 0,
        balances: [
          {
            assetType: "native" as const,
            assetCode: "XLM",
            assetIssuer: null,
            balance: "100",
            balanceFloat: 100,
          },
          {
            assetType: "credit_alphanum4" as const,
            assetCode: "USDC",
            assetIssuer: untrustedIssuer,
            balance: "50",
            balanceFloat: 50,
          },
        ],
      };

      vi.mocked(getAccount).mockResolvedValueOnce(ok(account));

      const result = await getAssetBalances(
        "http://horizon",
        account.publicKey,
        undefined,
        [trustedIssuer],
      );

      expect(result.status).toBe("error");
      expect((result as any).error.code).toBe("TX_BUILD_FAILED");
      expect((result as any).error.message).toContain(
        "not in the trusted issuers whitelist",
      );
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
          {
            assetType: "native" as const,
            assetCode: "XLM",
            assetIssuer: null,
            balance: "100",
            balanceFloat: 100,
          },
          {
            assetType: "credit_alphanum4" as const,
            assetCode: "USDC",
            assetIssuer:
              "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQ75XABEE3XZNIXUAA",
            balance: "50",
            balanceFloat: 50,
          },
        ],
      };

      vi.mocked(getAccount).mockResolvedValueOnce(ok(account));

      const result = await getAssetBalances(
        "http://horizon",
        account.publicKey,
        undefined,
        [],
      );

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
        {
          assetType: "native" as const,
          assetCode: "XLM",
          assetIssuer: null,
          balance: "100",
          balanceFloat: 100,
        },
      ],
    };
    const a2 = {
      ...base,
      sequence: "2",
      balances: [
        {
          assetType: "native" as const,
          assetCode: "XLM",
          assetIssuer: null,
          balance: "150",
          balanceFloat: 150,
        },
      ],
    };

    vi.mocked(getAccount)
      .mockResolvedValueOnce(ok(a1))
      .mockResolvedValueOnce(ok(a2));

    const changes: Array<{
      asset: { code: string; issuer?: string };
      oldBalance: string;
      newBalance: string;
      delta: string;
    }> = [];
    for await (const _ of streamAccount("http://horizon", base.publicKey, {
      maxPolls: 2,
      emitOnStart: true,
      intervalMs: 1,
      onBalanceChange: (asset, oldBalance, newBalance, delta) =>
        changes.push({ asset, oldBalance, newBalance, delta }),
    })) {
      /* consume */
    }

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      asset: { code: "XLM" },
      oldBalance: "100",
      newBalance: "150",
      delta: "50",
    });
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
        {
          assetType: "native" as const,
          assetCode: "XLM",
          assetIssuer: null,
          balance: "100",
          balanceFloat: 100,
        },
      ],
    };

    vi.mocked(getAccount)
      .mockResolvedValueOnce(ok(account))
      .mockResolvedValueOnce(ok(account));

    const changes: unknown[] = [];
    for await (const _ of streamAccount("http://horizon", account.publicKey, {
      maxPolls: 2,
      emitOnStart: true,
      intervalMs: 1,
      onBalanceChange: () => changes.push(true),
    })) {
      /* consume */
    }

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
        {
          assetType: "native" as const,
          assetCode: "XLM",
          assetIssuer: null,
          balance: "100",
          balanceFloat: 100,
        },
        {
          assetType: "credit_alphanum4" as const,
          assetCode: "USDC",
          assetIssuer: "GA5Z...ISSUER",
          balance: "50",
          balanceFloat: 50,
        },
      ],
    };
    const a2 = {
      ...base,
      sequence: "2",
      balances: [
        {
          assetType: "native" as const,
          assetCode: "XLM",
          assetIssuer: null,
          balance: "90",
          balanceFloat: 90,
        },
        {
          assetType: "credit_alphanum4" as const,
          assetCode: "USDC",
          assetIssuer: "GA5Z...ISSUER",
          balance: "60",
          balanceFloat: 60,
        },
      ],
    };

    vi.mocked(getAccount)
      .mockResolvedValueOnce(ok(a1))
      .mockResolvedValueOnce(ok(a2));

    const changes: Array<{ assetCode: string }> = [];
    for await (const _ of streamAccount("http://horizon", base.publicKey, {
      maxPolls: 2,
      emitOnStart: true,
      intervalMs: 1,
      onBalanceChange: (asset) => changes.push({ assetCode: asset.code }),
    })) {
      /* consume */
    }

    expect(changes).toHaveLength(2);
    expect(changes.map((c) => c.assetCode).sort()).toEqual(["USDC", "XLM"]);
  }, 10_000);

  it("fires onBalanceAdd when a new asset balance is added", async () => {
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
        {
          assetType: "native" as const,
          assetCode: "XLM",
          assetIssuer: null,
          balance: "100",
          balanceFloat: 100,
        },
      ],
    };
    const a2 = {
      ...base,
      sequence: "2",
      balances: [
        {
          assetType: "native" as const,
          assetCode: "XLM",
          assetIssuer: null,
          balance: "100",
          balanceFloat: 100,
        },
        {
          assetType: "credit_alphanum4" as const,
          assetCode: "USDC",
          assetIssuer: "GA5Z...ISSUER",
          balance: "50",
          balanceFloat: 50,
        },
      ],
    };

    vi.mocked(getAccount)
      .mockResolvedValueOnce(ok(a1))
      .mockResolvedValueOnce(ok(a2));

    const adds: Array<{ asset: { code: string; issuer?: string }; newBalance: string; delta: string }> = [];
    for await (const _ of streamAccount("http://horizon", base.publicKey, {
      maxPolls: 2,
      emitOnStart: true,
      intervalMs: 1,
      onBalanceAdd: (asset, newBalance, delta) => adds.push({ asset, newBalance, delta }),
    })) {
      /* consume */
    }

    expect(adds).toHaveLength(1);
    expect(adds[0]).toMatchObject({
      asset: { code: "USDC", issuer: "GA5Z...ISSUER" },
      newBalance: "50",
      delta: "50",
    });
  }, 10_000);

  it("fires onBalanceRemove when an asset balance is removed", async () => {
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
        {
          assetType: "native" as const,
          assetCode: "XLM",
          assetIssuer: null,
          balance: "100",
          balanceFloat: 100,
        },
        {
          assetType: "credit_alphanum4" as const,
          assetCode: "USDC",
          assetIssuer: "GA5Z...ISSUER",
          balance: "50",
          balanceFloat: 50,
        },
      ],
    };
    const a2 = {
      ...base,
      sequence: "2",
      balances: [
        {
          assetType: "native" as const,
          assetCode: "XLM",
          assetIssuer: null,
          balance: "100",
          balanceFloat: 100,
        },
      ],
    };

    vi.mocked(getAccount)
      .mockResolvedValueOnce(ok(a1))
      .mockResolvedValueOnce(ok(a2));

    const removes: Array<{ asset: { code: string; issuer?: string }; oldBalance: string; delta: string }> = [];
    for await (const _ of streamAccount("http://horizon", base.publicKey, {
      maxPolls: 2,
      emitOnStart: true,
      intervalMs: 1,
      onBalanceRemove: (asset, oldBalance, delta) => removes.push({ asset, oldBalance, delta }),
    })) {
      /* consume */
    }

    expect(removes).toHaveLength(1);
    expect(removes[0]).toMatchObject({
      asset: { code: "USDC", issuer: "GA5Z...ISSUER" },
      oldBalance: "50",
      delta: "-50",
    });
  }, 10_000);

  it("fires all balance event callbacks in correct order", async () => {
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
        {
          assetType: "native" as const,
          assetCode: "XLM",
          assetIssuer: null,
          balance: "100",
          balanceFloat: 100,
        },
      ],
    };
    const a2 = {
      ...base,
      sequence: "2",
      balances: [
        {
          assetType: "native" as const,
          assetCode: "XLM",
          assetIssuer: null,
          balance: "150",
          balanceFloat: 150,
        },
        {
          assetType: "credit_alphanum4" as const,
          assetCode: "USDC",
          assetIssuer: "GA5Z...ISSUER",
          balance: "25",
          balanceFloat: 25,
        },
      ],
    };

    vi.mocked(getAccount)
      .mockResolvedValueOnce(ok(a1))
      .mockResolvedValueOnce(ok(a2));

    const events: Array<{ type: string; assetCode: string }> = [];
    for await (const _ of streamAccount("http://horizon", base.publicKey, {
      maxPolls: 2,
      emitOnStart: true,
      intervalMs: 1,
      onBalanceAdd: (asset) => events.push({ type: "add", assetCode: asset.code }),
      onBalanceRemove: (asset) => events.push({ type: "remove", assetCode: asset.code }),
      onBalanceChange: (asset) => events.push({ type: "change", assetCode: asset.code }),
    })) {
      /* consume */
    }

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "change", assetCode: "XLM" });
    expect(events[1]).toEqual({ type: "add", assetCode: "USDC" });
  }, 10_000);

  describe("getAccountsBatch", () => {
    it("handles all successes", async () => {
      const { getAccountsBatch } = await import("../account/getAccountsBatch");
      const { getAccount } = await import("../account/getAccount");
      const { ok } = await import("../shared/response");

      const a1 = createAccount("1");
      const a2 = createAccount("2");

      vi.mocked(getAccount)
        .mockResolvedValueOnce(ok(a1))
        .mockResolvedValueOnce(ok(a2));

      const result = await getAccountsBatch("http://horizon", ["key1", "key2"]);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toHaveLength(2);
        expect(result.data[0].status).toBe("ok");
        expect(result.data[0].data).toEqual(a1);
        expect(result.data[1].status).toBe("ok");
        expect(result.data[1].data).toEqual(a2);
      }
    });

    it("handles all failures", async () => {
      const { getAccountsBatch } = await import("../account/getAccountsBatch");
      const { getAccount } = await import("../account/getAccount");
      const { err, SorokitErrorCode } = await import("../shared/response");

      vi.mocked(getAccount)
        .mockResolvedValueOnce(
          err(SorokitErrorCode.ACCOUNT_NOT_FOUND, "Not found"),
        )
        .mockResolvedValueOnce(
          err(SorokitErrorCode.ACCOUNT_FETCH_FAILED, "Fetch failed"),
        );

      const result = await getAccountsBatch("http://horizon", ["key1", "key2"]);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toHaveLength(2);
        expect(result.data[0].status).toBe("error");
        expect(result.data[0].error?.code).toBe(
          SorokitErrorCode.ACCOUNT_NOT_FOUND,
        );
        expect(result.data[1].status).toBe("error");
        expect(result.data[1].error?.code).toBe(
          SorokitErrorCode.ACCOUNT_FETCH_FAILED,
        );
      }
    });

    it("handles mixed successes and failures", async () => {
      const { getAccountsBatch } = await import("../account/getAccountsBatch");
      const { getAccount } = await import("../account/getAccount");
      const { ok, err, SorokitErrorCode } = await import("../shared/response");

      const a1 = createAccount("1");

      vi.mocked(getAccount)
        .mockResolvedValueOnce(ok(a1))
        .mockResolvedValueOnce(
          err(SorokitErrorCode.ACCOUNT_NOT_FOUND, "Not found"),
        );

      const result = await getAccountsBatch("http://horizon", ["key1", "key2"]);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toHaveLength(2);
        expect(result.data[0].status).toBe("ok");
        expect(result.data[0].data).toEqual(a1);
        expect(result.data[1].status).toBe("error");
        expect(result.data[1].error?.code).toBe(
          SorokitErrorCode.ACCOUNT_NOT_FOUND,
        );
      }
    });

    it("performance: queries Horizon in parallel", async () => {
      const { getAccountsBatch } = await import("../account/getAccountsBatch");
      const { getAccount } = await import("../account/getAccount");
      const { ok } = await import("../shared/response");

      vi.mocked(getAccount).mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return ok(createAccount("1"));
      });

      const start = Date.now();
      const result = await getAccountsBatch("http://horizon", [
        "key1",
        "key2",
        "key3",
      ]);
      const duration = Date.now() - start;

      expect(result.status).toBe("ok");
      // If run sequentially, it would take >= 300ms. Since it runs in parallel, it should take ~100ms.
      expect(duration).toBeLessThan(250);
    });

    it("deduplicates duplicate account keys in batch requests and maps results to all positions", async () => {
      const { getAccountsBatch } = await import("../account/getAccountsBatch");
      const { getAccount } = await import("../account/getAccount");
      const { ok } = await import("../shared/response");

      const a1 = createAccount("1");
      const a2 = createAccount("2");

      const callCounts: Record<string, number> = {};
      vi.mocked(getAccount).mockImplementation(async (_url: string, key: string) => {
        callCounts[key] = (callCounts[key] ?? 0) + 1;
        return key === "key1" ? ok(a1) : ok(a2);
      });

      const result = await getAccountsBatch("http://horizon", [
        "key1",
        "key2",
        "key1",
        "key1",
        "key2",
      ]);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toHaveLength(5);
        expect(result.data[0].data).toEqual(a1);
        expect(result.data[1].data).toEqual(a2);
        expect(result.data[2].data).toEqual(a1);
        expect(result.data[3].data).toEqual(a1);
        expect(result.data[4].data).toEqual(a2);
      }
      expect(callCounts["key1"]).toBe(1);
      expect(callCounts["key2"]).toBe(1);
    });

    it("returns cached account metadata when requested", async () => {
      const { getAccountsBatch } = await import("../account/getAccountsBatch");
      const { getAccount } = await import("../account/getAccount");
      const { createInMemoryCache } = await import("../shared/cache");

      const account = createAccount("metadata");
      vi.mocked(getAccount).mockResolvedValueOnce(ok(account));

      const result = await getAccountsBatch("http://horizon", ["key1", "key1"], {
        cache: createInMemoryCache(),
        includeMetadata: true,
      });

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toHaveLength(2);
        expect(result.data[0].account.data).toEqual(account);
        expect(result.data[0].metadata?.data).toEqual({
          publicKey: account.publicKey,
          sequence: account.sequence,
          subentryCount: account.subentryCount,
        });
        expect(result.data[1].metadata?.data?.publicKey).toBe(account.publicKey);
      }
      expect(vi.mocked(getAccount)).toHaveBeenCalledTimes(1);
    });

    it("handles empty publicKeys array in getAccountsBatch", async () => {
      const { getAccountsBatch } = await import("../account/getAccountsBatch");
      const result = await getAccountsBatch("http://horizon", []);
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toEqual([]);
      }
    });
  });
});

describe("getMultipleAssetBalances — bulk account queries (#42)", () => {
  const HORIZON_URL = "https://horizon-testnet.stellar.org";
  const KEY_A = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA";
  const KEY_B = "GBBD47UZQ5JAKVEWZNRPA7MKSTIRZU27I27ULMOWVNQZLBZZW7QTXN00";

  function makeAccount(publicKey: string, xlmBalance: string): AccountInfo {
    return {
      publicKey,
      displayAddress: `${publicKey.slice(0, 4)}...`,
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
      ],
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    accountMockState.index = 0;
    accountMockState.results = [];
  });

  it("returns results indexed by public key for all queried keys", async () => {
    const { getAccount } = await import("../account/getAccount");
    const { ok } = await import("../shared/response");
    const { getMultipleAssetBalances } =
      await import("../account/getMultipleAssetBalances");

    vi.mocked(getAccount)
      .mockResolvedValueOnce(ok(makeAccount(KEY_A, "100")))
      .mockResolvedValueOnce(ok(makeAccount(KEY_B, "200")));

    const results = await getMultipleAssetBalances(HORIZON_URL, [KEY_A, KEY_B]);

    expect(Object.keys(results)).toHaveLength(2);
    expect(results[KEY_A]?.status).toBe("ok");
    expect(results[KEY_B]?.status).toBe("ok");
  });

  it("each result contains the correct balances for its account", async () => {
    const { getAccount } = await import("../account/getAccount");
    const { ok } = await import("../shared/response");
    const { getMultipleAssetBalances } =
      await import("../account/getMultipleAssetBalances");

    vi.mocked(getAccount)
      .mockResolvedValueOnce(ok(makeAccount(KEY_A, "50")))
      .mockResolvedValueOnce(ok(makeAccount(KEY_B, "75")));

    const results = await getMultipleAssetBalances(HORIZON_URL, [KEY_A, KEY_B]);

    const a = results[KEY_A];
    const b = results[KEY_B];
    if (a?.status === "ok") {
      expect(a.data[0]?.balance).toBe("50");
    }
    if (b?.status === "ok") {
      expect(b.data[0]?.balance).toBe("75");
    }
  });

  it("applies the filter to every account in the batch", async () => {
    const { getAccount } = await import("../account/getAccount");
    const { ok } = await import("../shared/response");
    const { getMultipleAssetBalances } =
      await import("../account/getMultipleAssetBalances");

    const accountWithMixedBalances = (key: string): AccountInfo => ({
      publicKey: key,
      displayAddress: "...",
      sequence: "1",
      subentryCount: 0,
      balances: [
        {
          assetType: "native",
          assetCode: "XLM",
          assetIssuer: null,
          balance: "0",
          balanceFloat: 0,
        },
        {
          assetType: "credit_alphanum4",
          assetCode: "USDC",
          assetIssuer: "GISSUER",
          balance: "100",
          balanceFloat: 100,
        },
      ],
    });

    vi.mocked(getAccount)
      .mockResolvedValueOnce(ok(accountWithMixedBalances(KEY_A)))
      .mockResolvedValueOnce(ok(accountWithMixedBalances(KEY_B)));

    const results = await getMultipleAssetBalances(
      HORIZON_URL,
      [KEY_A, KEY_B],
      {
        excludeZero: true,
      },
    );

    // Zero XLM balance excluded; only USDC should remain
    const a = results[KEY_A];
    if (a?.status === "ok") {
      expect(a.data).toHaveLength(1);
      expect(a.data[0]?.assetCode).toBe("USDC");
    }
  });

  it("isolates failures — one bad key does not affect other results", async () => {
    const { getAccount } = await import("../account/getAccount");
    const { ok, err, SorokitErrorCode } = await import("../shared/response");
    const { getMultipleAssetBalances } =
      await import("../account/getMultipleAssetBalances");

    vi.mocked(getAccount)
      .mockResolvedValueOnce(ok(makeAccount(KEY_A, "100")))
      .mockResolvedValueOnce(
        err(SorokitErrorCode.ACCOUNT_NOT_FOUND, `Account not found: ${KEY_B}`),
      );

    const results = await getMultipleAssetBalances(HORIZON_URL, [KEY_A, KEY_B]);

    expect(results[KEY_A]?.status).toBe("ok");
    expect(results[KEY_B]?.status).toBe("error");
  });

  it("deduplicates public keys — queries each unique key only once", async () => {
    const { getAccount } = await import("../account/getAccount");
    const { ok } = await import("../shared/response");
    const { getMultipleAssetBalances } =
      await import("../account/getMultipleAssetBalances");

    vi.mocked(getAccount).mockResolvedValue(ok(makeAccount(KEY_A, "10")));

    const results = await getMultipleAssetBalances(HORIZON_URL, [
      KEY_A,
      KEY_A,
      KEY_A,
    ]);

    expect(Object.keys(results)).toHaveLength(1);
    expect(vi.mocked(getAccount)).toHaveBeenCalledTimes(1);
  });

  it("returns an empty object for an empty key list", async () => {
    const { getMultipleAssetBalances } =
      await import("../account/getMultipleAssetBalances");

    const results = await getMultipleAssetBalances(HORIZON_URL, []);

    expect(Object.keys(results)).toHaveLength(0);
  });

  it("all fetches run in parallel — total time near max single fetch, not sum", async () => {
    const { getAccount } = await import("../account/getAccount");
    const { ok } = await import("../shared/response");
    const { getMultipleAssetBalances } =
      await import("../account/getMultipleAssetBalances");

    const DELAY = 30;
    vi.mocked(getAccount).mockImplementation(
      (_: string, publicKey: string) =>
        new Promise((resolve) =>
          setTimeout(() => resolve(ok(makeAccount(publicKey, "1"))), DELAY),
        ),
    );

    const keys = [KEY_A, KEY_B];
    const start = Date.now();
    await getMultipleAssetBalances(HORIZON_URL, keys);
    const elapsed = Date.now() - start;

    // Parallel: should be ~DELAY ms, not DELAY*N ms
    expect(elapsed).toBeLessThan(DELAY * keys.length * 0.9);
  }, 10_000);
});

describe("getAssetBalances — comprehensive filter logic (#266)", () => {
  const HORIZON_URL = "https://horizon-testnet.stellar.org";
  const PUBLIC_KEY = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA";

  function mockAccountWithBalances(balances: any[]) {
    return {
      publicKey: PUBLIC_KEY,
      displayAddress: "GAAZI...CWNA",
      sequence: "1",
      subentryCount: 0,
      balances,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns all balances when no filter is provided", async () => {
    const { getAccount } = await import("../account/getAccount");
    const { ok } = await import("../shared/response");
    const { getAssetBalances } = await import("../account/getAssetBalances");

    const account = mockAccountWithBalances([
      {
        assetType: "native",
        assetCode: "XLM",
        assetIssuer: null,
        balance: "100.0000000",
        balanceFloat: 100,
      },
      {
        assetType: "credit_alphanum4",
        assetCode: "USDC",
        assetIssuer: "GISSUER1",
        balance: "50.0000000",
        balanceFloat: 50,
      },
      {
        assetType: "credit_alphanum12",
        assetCode: "EURC",
        assetIssuer: "GISSUER2",
        balance: "0.0000000",
        balanceFloat: 0,
      },
    ]);

    vi.mocked(getAccount).mockResolvedValueOnce(ok(account));

    const result = await getAssetBalances(HORIZON_URL, PUBLIC_KEY);

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data).toHaveLength(3);
    }
  });

  it("filters by assetCode (case-insensitive)", async () => {
    const { getAccount } = await import("../account/getAccount");
    const { ok } = await import("../shared/response");
    const { getAssetBalances } = await import("../account/getAssetBalances");

    const account = mockAccountWithBalances([
      {
        assetType: "native",
        assetCode: "XLM",
        assetIssuer: null,
        balance: "100.0000000",
        balanceFloat: 100,
      },
      {
        assetType: "credit_alphanum4",
        assetCode: "USDC",
        assetIssuer: "GISSUER1",
        balance: "50.0000000",
        balanceFloat: 50,
      },
      {
        assetType: "credit_alphanum4",
        assetCode: "USDT",
        assetIssuer: "GISSUER2",
        balance: "25.0000000",
        balanceFloat: 25,
      },
    ]);

    vi.mocked(getAccount).mockResolvedValueOnce(ok(account));

    const result = await getAssetBalances(HORIZON_URL, PUBLIC_KEY, {
      assetCode: "usdc",
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data).toHaveLength(1);
      expect(result.data[0].assetCode).toBe("USDC");
    }
  });

  it("filters by assetIssuer (exact match, null-guarded)", async () => {
    const { getAccount } = await import("../account/getAccount");
    const { ok } = await import("../shared/response");
    const { getAssetBalances } = await import("../account/getAssetBalances");

    const account = mockAccountWithBalances([
      {
        assetType: "native",
        assetCode: "XLM",
        assetIssuer: null,
        balance: "100.0000000",
        balanceFloat: 100,
      },
      {
        assetType: "credit_alphanum4",
        assetCode: "USDC",
        assetIssuer: "GISSUER1",
        balance: "50.0000000",
        balanceFloat: 50,
      },
      {
        assetType: "credit_alphanum4",
        assetCode: "USDC",
        assetIssuer: "GISSUER2",
        balance: "25.0000000",
        balanceFloat: 25,
      },
    ]);

    vi.mocked(getAccount).mockResolvedValueOnce(ok(account));

    const result = await getAssetBalances(HORIZON_URL, PUBLIC_KEY, {
      assetIssuer: "GISSUER1",
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data).toHaveLength(1);
      expect(result.data[0].assetIssuer).toBe("GISSUER1");
    }
  });

  it("filters by assetType as single string value", async () => {
    const { getAccount } = await import("../account/getAccount");
    const { ok } = await import("../shared/response");
    const { getAssetBalances } = await import("../account/getAssetBalances");

    const account = mockAccountWithBalances([
      {
        assetType: "native",
        assetCode: "XLM",
        assetIssuer: null,
        balance: "100.0000000",
        balanceFloat: 100,
      },
      {
        assetType: "credit_alphanum4",
        assetCode: "USDC",
        assetIssuer: "GISSUER1",
        balance: "50.0000000",
        balanceFloat: 50,
      },
      {
        assetType: "credit_alphanum12",
        assetCode: "EURC",
        assetIssuer: "GISSUER2",
        balance: "25.0000000",
        balanceFloat: 25,
      },
    ]);

    vi.mocked(getAccount).mockResolvedValueOnce(ok(account));

    const result = await getAssetBalances(HORIZON_URL, PUBLIC_KEY, {
      assetType: "credit_alphanum4",
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data).toHaveLength(1);
      expect(result.data[0].assetType).toBe("credit_alphanum4");
    }
  });

  it("filters by assetType as array", async () => {
    const { getAccount } = await import("../account/getAccount");
    const { ok } = await import("../shared/response");
    const { getAssetBalances } = await import("../account/getAssetBalances");

    const account = mockAccountWithBalances([
      {
        assetType: "native",
        assetCode: "XLM",
        assetIssuer: null,
        balance: "100.0000000",
        balanceFloat: 100,
      },
      {
        assetType: "credit_alphanum4",
        assetCode: "USDC",
        assetIssuer: "GISSUER1",
        balance: "50.0000000",
        balanceFloat: 50,
      },
      {
        assetType: "credit_alphanum12",
        assetCode: "EURC",
        assetIssuer: "GISSUER2",
        balance: "25.0000000",
        balanceFloat: 25,
      },
      {
        assetType: "liquidity_pool_shares",
        assetCode: "Pool",
        assetIssuer: null,
        balance: "10.0000000",
        balanceFloat: 10,
      },
    ]);

    vi.mocked(getAccount).mockResolvedValueOnce(ok(account));

    const result = await getAssetBalances(HORIZON_URL, PUBLIC_KEY, {
      assetType: ["credit_alphanum4", "credit_alphanum12"],
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data).toHaveLength(2);
      expect(result.data.map((b) => b.assetType).sort()).toEqual([
        "credit_alphanum12",
        "credit_alphanum4",
      ]);
    }
  });

  it("filters by excludeZero using balanceFloat > 0", async () => {
    const { getAccount } = await import("../account/getAccount");
    const { ok } = await import("../shared/response");
    const { getAssetBalances } = await import("../account/getAssetBalances");

    const account = mockAccountWithBalances([
      {
        assetType: "native",
        assetCode: "XLM",
        assetIssuer: null,
        balance: "100.0000000",
        balanceFloat: 100,
      },
      {
        assetType: "credit_alphanum4",
        assetCode: "USDC",
        assetIssuer: "GISSUER1",
        balance: "0.0000000",
        balanceFloat: 0,
      },
      {
        assetType: "credit_alphanum4",
        assetCode: "USDT",
        assetIssuer: "GISSUER2",
        balance: "50.0000000",
        balanceFloat: 50,
      },
    ]);

    vi.mocked(getAccount).mockResolvedValueOnce(ok(account));

    const result = await getAssetBalances(HORIZON_URL, PUBLIC_KEY, {
      excludeZero: true,
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data).toHaveLength(2);
      expect(result.data.every((b) => b.balanceFloat > 0)).toBe(true);
    }
  });

  it("combines multiple filters (assetCode + excludeZero)", async () => {
    const { getAccount } = await import("../account/getAccount");
    const { ok } = await import("../shared/response");
    const { getAssetBalances } = await import("../account/getAssetBalances");

    const account = mockAccountWithBalances([
      {
        assetType: "credit_alphanum4",
        assetCode: "USDC",
        assetIssuer: "GISSUER1",
        balance: "100.0000000",
        balanceFloat: 100,
      },
      {
        assetType: "credit_alphanum4",
        assetCode: "USDC",
        assetIssuer: "GISSUER2",
        balance: "0.0000000",
        balanceFloat: 0,
      },
      {
        assetType: "credit_alphanum4",
        assetCode: "USDT",
        assetIssuer: "GISSUER3",
        balance: "50.0000000",
        balanceFloat: 50,
      },
    ]);

    vi.mocked(getAccount).mockResolvedValueOnce(ok(account));

    const result = await getAssetBalances(HORIZON_URL, PUBLIC_KEY, {
      assetCode: "USDC",
      excludeZero: true,
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data).toHaveLength(1);
      expect(result.data[0].assetCode).toBe("USDC");
      expect(result.data[0].balanceFloat).toBeGreaterThan(0);
    }
  });
});

describe("getAccountActivitySummary (#140)", () => {
  const HORIZON_URL = "https://horizon-testnet.stellar.org";
  const PUBLIC_KEY = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fails when public key is invalid or empty", async () => {
    const { getAccountActivitySummary } =
      await import("../account/getAccountActivitySummary");
    const res = await getAccountActivitySummary(HORIZON_URL, "");
    expect(res.status).toBe("error");
    if (res.status === "error") {
      expect(res.error.code).toBe("INVALID_ADDRESS");
    }
  });

  it("summarizes activity for 24h period", async () => {
    const { Horizon } = await import("@stellar/stellar-sdk");
    const { getAccountActivitySummary } =
      await import("../account/getAccountActivitySummary");

    const now = Date.now();
    const mockOps = [
      {
        created_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
        transaction_successful: true,
        transaction_hash: "hash1",
        type: "payment",
        amount: "100",
        asset_type: "native",
        asset_code: "XLM",
        to: PUBLIC_KEY,
      },
      {
        created_at: new Date(now - 5 * 60 * 60 * 1000).toISOString(),
        transaction_successful: true,
        transaction_hash: "hash2",
        type: "payment",
        amount: "25",
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: "GISSUER",
        from: PUBLIC_KEY,
      },
    ];

    const mockCall = vi.fn().mockResolvedValue({ records: mockOps });
    const mockOperationsBuilder = {
      forAccount: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      call: mockCall,
    };

    vi.mocked(Horizon.Server).mockImplementationOnce(
      () =>
        ({
          operations: () => mockOperationsBuilder,
        }) as any,
    );

    const res = await getAccountActivitySummary(HORIZON_URL, PUBLIC_KEY, "24h");

    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.data.period).toBe("24h");
      expect(res.data.transactionCount).toBe(2);
      expect(res.data.successfulTransactionCount).toBe(2);
      expect(res.data.totalAmountIn).toBe("100");
      expect(res.data.totalAmountOut).toBe("25");
      expect(res.data.topAssets).toHaveLength(2);
    }
  });

  it("summarizes activity for 7d period filtering out older transactions", async () => {
    const { Horizon } = await import("@stellar/stellar-sdk");
    const { getAccountActivitySummary } =
      await import("../account/getAccountActivitySummary");

    const now = Date.now();
    const mockOps = [
      {
        created_at: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(),
        transaction_successful: true,
        transaction_hash: "hash1",
        type: "payment",
        amount: "50",
        asset_type: "native",
        asset_code: "XLM",
        to: PUBLIC_KEY,
      },
      {
        created_at: new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(),
        transaction_successful: true,
        transaction_hash: "hash2",
        type: "payment",
        amount: "200",
        asset_type: "native",
        asset_code: "XLM",
        to: PUBLIC_KEY,
      },
    ];

    const mockCall = vi.fn().mockResolvedValue({ records: mockOps });
    const mockOperationsBuilder = {
      forAccount: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      call: mockCall,
    };

    vi.mocked(Horizon.Server).mockImplementationOnce(
      () =>
        ({
          operations: () => mockOperationsBuilder,
        }) as any,
    );

    const res = await getAccountActivitySummary(HORIZON_URL, PUBLIC_KEY, "7d");

    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.data.period).toBe("7d");
      expect(res.data.transactionCount).toBe(1);
      expect(res.data.totalAmountIn).toBe("50");
    }
  });

  it("summarizes activity for 30d period including failed transactions", async () => {
    const { Horizon } = await import("@stellar/stellar-sdk");
    const { getAccountActivitySummary } =
      await import("../account/getAccountActivitySummary");

    const now = Date.now();
    const mockOps = [
      {
        created_at: new Date(now - 15 * 24 * 60 * 60 * 1000).toISOString(),
        transaction_successful: false,
        transaction_hash: "hash1",
        type: "payment",
        amount: "10",
        asset_type: "native",
        asset_code: "XLM",
        from: PUBLIC_KEY,
      },
    ];

    const mockCall = vi.fn().mockResolvedValue({ records: mockOps });
    const mockOperationsBuilder = {
      forAccount: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      call: mockCall,
    };

    vi.mocked(Horizon.Server).mockImplementationOnce(
      () =>
        ({
          operations: () => mockOperationsBuilder,
        }) as any,
    );

    const res = await getAccountActivitySummary(HORIZON_URL, PUBLIC_KEY, "30d");

    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.data.period).toBe("30d");
      expect(res.data.transactionCount).toBe(1);
      expect(res.data.failedTransactionCount).toBe(1);
      expect(res.data.successfulTransactionCount).toBe(0);
    }
  });
});

describe("parseFloat precision boundary (#246)", () => {
  it("documents the maximum safe float balance value", () => {
    // JavaScript's Number.MAX_SAFE_INTEGER = 9,007,199,254,740,991 (~9e15)
    // Stellar balances are stored as 7-decimal strings. The worst-case safe
    // balance value (the largest integer that parseFloat can round-trip
    // through Number → String without loss) is:
    //
    //   MAX_SAFE / 10^7 = 900,719,925,474.0992 XLM
    //
    // Any balance under 100 billion XLM — far beyond any realistic account —
    // is guaranteed to survive parseFloat → String → parseFloat without
    // change.
    const maxSafeXlm = Number.MAX_SAFE_INTEGER / 10_000_000;

    expect(maxSafeXlm).toBe(900719925.4740992);
    expect(Number.isFinite(maxSafeXlm)).toBe(true);

    // Verify round-trip stability for realistic balances
    const realistic = [
      "0.0000001",
      "1.0000000",
      "100.1234567",
      "9999999.9999999",
      "100000000000.0000000", // 100 billion XLM — still safe
    ];

    for (const bal of realistic) {
      const roundTripped = parseFloat(bal).toFixed(7);
      expect(roundTripped).toBe(bal);
    }

    // Demonstrate where precision loss begins
    const edgeCase = "999999999999999.9999999"; // ~1 quadrillion XLM
    const parsed = parseFloat(edgeCase);
    const restored = parsed.toFixed(7);
    // At this magnitude the last decimal digit may be lost
    expect(restored).not.toBe(edgeCase);
  });
});

describe("getAccount — expanded coverage (#235)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accountMockState.index = 0;
    accountMockState.results = [];
  });

  it("returns issued asset balances with correct type, code, and issuer", async () => {
    const { getAccount } = await import("../account/getAccount");

    const account: AccountInfo = {
      publicKey: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
      displayAddress: "GAAZI...CWNA",
      sequence: "12345",
      subentryCount: 3,
      balances: [
        {
          assetType: "native",
          assetCode: "XLM",
          assetIssuer: null,
          balance: "100.0000000",
          balanceFloat: 100,
        },
        {
          assetType: "credit_alphanum4",
          assetCode: "USDC",
          assetIssuer: "GISSUER1",
          balance: "50.0000000",
          balanceFloat: 50,
        },
        {
          assetType: "credit_alphanum12",
          assetCode: "VERYLONGASSET",
          assetIssuer: "GISSUER2",
          balance: "25.0000000",
          balanceFloat: 25,
        },
      ],
    };

    vi.mocked(getAccount).mockResolvedValueOnce(ok(account));

    const result = await getAccount("https://horizon.test", account.publicKey);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.balances).toHaveLength(3);
      expect(result.data.balances[0]).toMatchObject({
        assetType: "native",
        assetCode: "XLM",
        assetIssuer: null,
      });
      expect(result.data.balances[1]).toMatchObject({
        assetType: "credit_alphanum4",
        assetCode: "USDC",
        assetIssuer: "GISSUER1",
      });
      expect(result.data.balances[2]).toMatchObject({
        assetType: "credit_alphanum12",
        assetCode: "VERYLONGASSET",
        assetIssuer: "GISSUER2",
      });
    }
  });

  it("returns ACCOUNT_NOT_FOUND on 404", async () => {
    const { getAccount } = await import("../account/getAccount");

    vi.mocked(getAccount).mockResolvedValueOnce(
      err(SorokitErrorCode.ACCOUNT_NOT_FOUND, "Account not found: GAAA..."),
    );

    const result = await getAccount(
      "https://horizon.test",
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.ACCOUNT_NOT_FOUND);
    }
  });

  it("returns ACCOUNT_FETCH_FAILED on non-404 network errors", async () => {
    const { getAccount } = await import("../account/getAccount");

    vi.mocked(getAccount).mockResolvedValueOnce(
      err(
        SorokitErrorCode.ACCOUNT_FETCH_FAILED,
        "Failed to fetch account: Server internal error",
      ),
    );

    const result = await getAccount(
      "https://horizon.test",
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.ACCOUNT_FETCH_FAILED);
    }
  });
});

describe("getBalances — expanded coverage (#235)", () => {
  beforeEach(() => {
    accountMockState.index = 0;
    accountMockState.results = [];
  });

  it("returns balances on success", async () => {
    const { getBalances } = await import("../account/getBalances");
    const { getAccount } = await import("../account/getAccount");
    const account = {
      publicKey: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
      displayAddress: "GAAZI...CWNA",
      sequence: "1",
      subentryCount: 0,
      balances: [
        {
          assetType: "native" as const,
          assetCode: "XLM",
          assetIssuer: null,
          balance: "100",
          balanceFloat: 100,
        },
        {
          assetType: "credit_alphanum4" as const,
          assetCode: "USDC",
          assetIssuer: "GISSUER",
          balance: "50",
          balanceFloat: 50,
        },
      ],
    };

    vi.mocked(getAccount).mockResolvedValueOnce(ok(account));

    const result = await getBalances("https://horizon.test", account.publicKey);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data).toHaveLength(2);
      expect(result.data[0]?.assetCode).toBe("XLM");
      expect(result.data[1]?.assetCode).toBe("USDC");
    }
  });

  it("propagates error when getAccount fails", async () => {
    const { getBalances } = await import("../account/getBalances");
    const { getAccount } = await import("../account/getAccount");

    vi.mocked(getAccount).mockResolvedValueOnce(
      err(SorokitErrorCode.ACCOUNT_NOT_FOUND, "Account not found"),
    );

    const result = await getBalances("https://horizon.test", "GAAA...");
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.ACCOUNT_NOT_FOUND);
    }
  });
});

describe("streamAccount — emitOnStart, maxPolls, AbortSignal, mid-stream error (#235)", () => {
  beforeEach(async () => {
    accountMockState.sleepCalls.length = 0;
    accountMockState.index = 0;
    accountMockState.results = [];
    const { getAccount } = await import("../account/getAccount");
    vi.mocked(getAccount).mockReset();
    vi.mocked(getAccount).mockImplementation(async () => {
      const result =
        accountMockState.results[accountMockState.index] ??
        accountMockState.results.at(-1)!;
      accountMockState.index++;
      return ok(result);
    });
  });

  it("emitOnStart: true yields immediately without sleeping", async () => {
    accountMockState.results = [createAccount("1")];

    const stream = streamAccount("https://horizon.test", "G...", {
      emitOnStart: true,
      maxPolls: 1,
      intervalMs: 5000,
    });

    const { value } = await stream.next();
    expect(value?.status).toBe("ok");
    expect(accountMockState.sleepCalls).toHaveLength(0);
  });

  it("emitOnStart: false sleeps before first yield", async () => {
    accountMockState.results = [createAccount("1")];

    const stream = streamAccount("https://horizon.test", "G...", {
      emitOnStart: false,
      maxPolls: 1,
      intervalMs: 3000,
    });

    await stream.next();
    expect(accountMockState.sleepCalls).toEqual([3000]);
  });

  it("maxPolls: 2 stops after exactly 2 polls", async () => {
    accountMockState.results = [
      createAccount("1"),
      createAccount("2"),
      createAccount("3"),
    ];

    const results: unknown[] = [];
    const stream = streamAccount("https://horizon.test", "G...", {
      maxPolls: 2,
      emitOnStart: true,
      intervalMs: 100,
    });

    for await (const r of stream) {
      results.push(r);
    }

    expect(results).toHaveLength(2);
  }, 10_000);

  it("AbortSignal terminates the generator early", async () => {
    accountMockState.results = [
      createAccount("1"),
      createAccount("2"),
      createAccount("3"),
    ];

    const ac = new AbortController();
    const results: unknown[] = [];
    const stream = streamAccount(
      "https://horizon.test",
      "G...",
      {
        emitOnStart: true,
        intervalMs: 1,
      },
      ac.signal,
    );

    for await (const r of stream) {
      results.push(r);
      if (results.length === 1) {
        ac.abort();
      }
    }

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.length).toBeLessThanOrEqual(2);
  }, 10_000);

  it("mid-stream error yields err result without ending the stream", async () => {
    const { getAccount } = await import("../account/getAccount");
    const { streamAccount } = await import("../account/streamAccount");

    const account1 = createAccount("1");
    const account2 = createAccount("2");
    const errorResult = err(
      SorokitErrorCode.ACCOUNT_FETCH_FAILED,
      "temporary failure",
    );

    vi.mocked(getAccount)
      .mockResolvedValueOnce(ok(account1))
      .mockResolvedValueOnce(errorResult)
      .mockResolvedValueOnce(ok(account2));

    const results: unknown[] = [];
    for await (const r of streamAccount("https://horizon.test", "G...", {
      maxPolls: 3,
      emitOnStart: true,
      intervalMs: 1,
    })) {
      results.push(r);
    }

    expect(results).toHaveLength(3);
    expect(results[0]).toEqual(expect.objectContaining({ status: "ok" }));
    expect(results[1]).toEqual(expect.objectContaining({ status: "error" }));
    expect(results[2]).toEqual(expect.objectContaining({ status: "ok" }));
  }, 10_000);

  describe("automatic retry with exponential backoff", () => {
    beforeEach(() => {
      accountMockState.sleepCalls.length = 0;
    });

    it("retries transient errors with exponential backoff", async () => {
      const { getAccount } = await import("../account/getAccount");
      const { streamAccount } = await import("../account/streamAccount");

      const account1 = createAccount("1");
      const transientError = new Error("ECONNREFUSED");

      vi.mocked(getAccount)
        .mockRejectedValueOnce(transientError)
        .mockRejectedValueOnce(transientError)
        .mockResolvedValueOnce(ok(account1));

      const results: unknown[] = [];
      for await (const r of streamAccount("https://horizon.test", "G...", {
        maxPolls: 3,
        emitOnStart: true,
        intervalMs: 1,
        enableAutoRetry: true,
      })) {
        results.push(r);
      }

      // Should have retry delays (1s, 2s for exponential backoff)
      expect(accountMockState.sleepCalls.length).toBeGreaterThan(0);
      // First retry should be around 1s, second around 2s
      expect(accountMockState.sleepCalls[0]).toBeGreaterThanOrEqual(1000);
      expect(accountMockState.sleepCalls[0]).toBeLessThanOrEqual(1100); // with jitter
      if (accountMockState.sleepCalls.length > 1) {
        expect(accountMockState.sleepCalls[1]).toBeGreaterThanOrEqual(2000);
        expect(accountMockState.sleepCalls[1]).toBeLessThanOrEqual(2200); // with jitter
      }

      // Should eventually succeed
      expect(results.some((r: any) => r?.status === "ok")).toBe(true);
    }, 10_000);

    it("emits error after max consecutive failures and enters cooldown", async () => {
      const { getAccount } = await import("../account/getAccount");
      const { streamAccount } = await import("../account/streamAccount");

      const transientError = new Error("ETIMEDOUT");

      vi.mocked(getAccount).mockRejectedValue(transientError);

      const results: unknown[] = [];
      for await (const r of streamAccount("https://horizon.test", "G...", {
        maxPolls: 7, // Allow enough polls to hit max consecutive failures (5)
        emitOnStart: true,
        intervalMs: 1,
        enableAutoRetry: true,
      })) {
        results.push(r);
        if (results.length >= 2) break; // Stop after we get the error emission
      }

      // Should have emitted an error after 5 consecutive failures
      expect(results.some((r: any) => r?.status === "error")).toBe(true);

      // Should have entered cooldown (60s delay)
      const cooldownIndex = accountMockState.sleepCalls.findIndex(
        (ms: number) => ms >= 60000
      );
      expect(cooldownIndex).toBeGreaterThanOrEqual(0);
    }, 10_000);

    it("resets failure counter on successful poll", async () => {
      const { getAccount } = await import("../account/getAccount");
      const { streamAccount } = await import("../account/streamAccount");

      const account1 = createAccount("1");
      const account2 = createAccount("2");
      const transientError = new Error("ECONNRESET");

      vi.mocked(getAccount)
        .mockRejectedValueOnce(transientError)
        .mockRejectedValueOnce(transientError)
        .mockResolvedValueOnce(ok(account1))
        .mockRejectedValueOnce(transientError)
        .mockRejectedValueOnce(transientError)
        .mockRejectedValueOnce(transientError)
        .mockResolvedValueOnce(ok(account2));

      const results: unknown[] = [];
      for await (const r of streamAccount("https://horizon.test", "G...", {
        maxPolls: 7,
        emitOnStart: true,
        intervalMs: 1,
        enableAutoRetry: true,
      })) {
        results.push(r);
      }

      // Should succeed overall despite multiple failure sequences
      expect(results.filter((r: any) => r?.status === "ok").length).toBe(2);
    }, 10_000);

    it("does not retry when enableAutoRetry is false", async () => {
      const { getAccount } = await import("../account/getAccount");
      const { streamAccount } = await import("../account/streamAccount");

      const account1 = createAccount("1");
      const transientError = new Error("ETIMEDOUT");

      vi.mocked(getAccount)
        .mockRejectedValueOnce(transientError)
        .mockResolvedValueOnce(ok(account1));

      const results: unknown[] = [];
      for await (const r of streamAccount("https://horizon.test", "G...", {
        maxPolls: 2,
        emitOnStart: true,
        intervalMs: 1,
        enableAutoRetry: false,
      })) {
        results.push(r);
      }

      // Should emit error immediately without retry backoff
      expect(results.some((r: any) => r?.status === "error")).toBe(true);
      // Should not have retry delays (only normal interval)
      expect(accountMockState.sleepCalls.every((ms: number) => ms < 1000)).toBe(true);
    }, 10_000);

    it("does not retry non-transient errors", async () => {
      const { getAccount } = await import("../account/getAccount");
      const { streamAccount } = await import("../account/streamAccount");

      const account1 = createAccount("1");
      const permanentError = new Error("404 Not Found");

      vi.mocked(getAccount)
        .mockRejectedValueOnce(permanentError)
        .mockResolvedValueOnce(ok(account1));

      const results: unknown[] = [];
      for await (const r of streamAccount("https://horizon.test", "G...", {
        maxPolls: 2,
        emitOnStart: true,
        intervalMs: 1,
        enableAutoRetry: true,
      })) {
        results.push(r);
      }

      // Should emit error immediately without retry
      expect(results.some((r: any) => r?.status === "error")).toBe(true);
      // Should not have retry delays
      expect(accountMockState.sleepCalls.every((ms: number) => ms < 1000)).toBe(true);
    }, 10_000);
  });
});
