/**
 * Integration test: account streaming + transaction monitoring workflow
 *
 * Tests the async generator-based streaming APIs for account state polling
 * and transaction monitoring.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSorokitClient } from "../../client/createSorokitClient";
import { streamAccount } from "../../account/streamAccount";
import { streamTransactions } from "../../transaction/streamTransactions";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockLoadAccount, mockTransactionsCall } = vi.hoisted(() => ({
  mockLoadAccount: vi.fn(),
  mockTransactionsCall: vi.fn(),
}));

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: vi.fn().mockImplementation(() => ({
        loadAccount: mockLoadAccount,
        transactions: vi.fn().mockImplementation(() => {
          const b: Record<string, unknown> = {
            forAccount: vi.fn(() => b),
            limit: vi.fn(() => b),
            order: vi.fn(() => b),
            cursor: vi.fn(() => b),
            call: mockTransactionsCall,
          };
          return b;
        }),
      })),
    },
  };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TEST_PUBLIC_KEY = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA";
const HORIZON_URL = "https://horizon-testnet.stellar.org";

function makeHorizonAccount(balance = "10.0000000") {
  return {
    id: TEST_PUBLIC_KEY,
    account_id: TEST_PUBLIC_KEY,
    accountId: () => TEST_PUBLIC_KEY,
    sequence: "100",
    sequenceNumber: () => "100",
    incrementSequenceNumber: vi.fn(),
    subentry_count: 0,
    balances: [
      {
        balance,
        asset_type: "native",
        asset_code: "XLM",
        asset_issuer: undefined,
      },
    ],
    flags: {},
    signers: [],
    data_attr: {},
    thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
    home_domain: "",
    inflation_dest: undefined,
    last_modified_ledger: 100,
  };
}

function makeHorizonTxRecord(hash: string, successful: boolean, pagingToken: string) {
  return {
    hash,
    successful,
    ledger_attr: 1000,
    created_at: "2024-01-01T00:00:00Z",
    fee_charged: "100",
    envelope_xdr: "envelope",
    result_xdr: "result",
    paging_token: pagingToken,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("integration: account streaming", () => {
  beforeEach(() => {
    mockLoadAccount.mockReset();
    mockTransactionsCall.mockReset();
  });

  it("yields account state on the first poll", async () => {
    mockLoadAccount.mockResolvedValueOnce(makeHorizonAccount("15.0000000"));

    const stream = streamAccount(HORIZON_URL, TEST_PUBLIC_KEY, {
      maxPolls: 1,
      intervalMs: 10,
    });

    const { value, done } = await stream.next();

    expect(done).toBe(false);
    expect(value?.status).toBe("ok");
    if (value?.status === "ok") {
      expect(value.data.publicKey).toBe(TEST_PUBLIC_KEY);
      const xlm = value.data.balances.find((b) => b.assetCode === "XLM");
      expect(xlm?.balance).toBe("15.0000000");
    }
  });

  it("yields multiple account state updates across polls", async () => {
    mockLoadAccount
      .mockResolvedValueOnce(makeHorizonAccount("10.0000000"))
      .mockResolvedValueOnce(makeHorizonAccount("8.0000000"));

    const stream = streamAccount(HORIZON_URL, TEST_PUBLIC_KEY, {
      maxPolls: 2,
      intervalMs: 10,
    });

    const results = [];
    for await (const result of stream) {
      results.push(result);
    }

    expect(results).toHaveLength(2);
    expect(results[0]?.status).toBe("ok");
    expect(results[1]?.status).toBe("ok");

    if (results[0]?.status === "ok" && results[1]?.status === "ok") {
      const balance0 = results[0].data.balances.find((b) => b.assetCode === "XLM");
      const balance1 = results[1].data.balances.find((b) => b.assetCode === "XLM");
      expect(balance0?.balance).toBe("10.0000000");
      expect(balance1?.balance).toBe("8.0000000");
    }
  });

  it("stops streaming when aborted via AbortSignal", async () => {
    mockLoadAccount.mockResolvedValue(makeHorizonAccount());

    const controller = new AbortController();
    const stream = streamAccount(HORIZON_URL, TEST_PUBLIC_KEY, { intervalMs: 50 }, controller.signal);

    // Collect the first result then abort
    const firstResult = await stream.next();
    controller.abort();

    const secondResult = await stream.next();

    expect(firstResult.value?.status).toBe("ok");
    // After abort, generator should be done
    expect(secondResult.done).toBe(true);
  });

  it("yields error result when account fetch fails", async () => {
    mockLoadAccount.mockRejectedValueOnce(new Error("network timeout"));

    const stream = streamAccount(HORIZON_URL, TEST_PUBLIC_KEY, {
      maxPolls: 1,
      intervalMs: 10,
    });

    const { value } = await stream.next();

    expect(value?.status).toBe("error");
  });
});

describe("integration: transaction monitoring", () => {
  beforeEach(() => {
    mockTransactionsCall.mockReset();
  });

  it("yields a page of transactions on the first poll", async () => {
    mockTransactionsCall.mockResolvedValueOnce({
      records: [
        makeHorizonTxRecord("tx_aaa", true, "cursor_1"),
        makeHorizonTxRecord("tx_bbb", false, "cursor_2"),
      ],
    });

    const stream = streamTransactions(HORIZON_URL, TEST_PUBLIC_KEY, { maxPolls: 1 });
    const { value } = await stream.next();

    expect(value?.status).toBe("ok");
    if (value?.status === "ok") {
      expect(value.data.transactions).toHaveLength(2);
      expect(value.data.transactions[0]?.hash).toBe("tx_aaa");
      expect(value.data.transactions[0]?.status).toBe("success");
      expect(value.data.transactions[1]?.status).toBe("failed");
      expect(value.data.nextCursor).toBe("cursor_2");
    }
  });

  it("filters transactions by success status", async () => {
    mockTransactionsCall.mockResolvedValueOnce({
      records: [
        makeHorizonTxRecord("tx_success", true, "cursor_s"),
        makeHorizonTxRecord("tx_fail", false, "cursor_f"),
      ],
    });

    const stream = streamTransactions(HORIZON_URL, TEST_PUBLIC_KEY, {
      maxPolls: 1,
      statuses: ["success"],
    });

    const { value } = await stream.next();

    expect(value?.status).toBe("ok");
    if (value?.status === "ok") {
      expect(value.data.transactions).toHaveLength(1);
      expect(value.data.transactions[0]?.hash).toBe("tx_success");
    }
  });

  it("advances cursor between polls", async () => {
    mockTransactionsCall
      .mockResolvedValueOnce({
        records: [makeHorizonTxRecord("tx_1", true, "cursor_a")],
      })
      .mockResolvedValueOnce({
        records: [makeHorizonTxRecord("tx_2", true, "cursor_b")],
      });

    const stream = streamTransactions(HORIZON_URL, TEST_PUBLIC_KEY, { maxPolls: 2, intervalMs: 10 });

    const results = [];
    for await (const result of stream) {
      results.push(result);
    }

    expect(results).toHaveLength(2);
    if (results[0]?.status === "ok" && results[1]?.status === "ok") {
      expect(results[0].data.transactions[0]?.hash).toBe("tx_1");
      expect(results[1].data.transactions[0]?.hash).toBe("tx_2");
    }
  });

  it("client transaction.stream yields through the client interface", async () => {
    mockTransactionsCall.mockResolvedValueOnce({
      records: [makeHorizonTxRecord("tx_client", true, "cursor_c")],
    });

    const clientResult = createSorokitClient({ network: "testnet" });
    if (clientResult.status !== "ok") return;

    const stream = clientResult.data.transaction.stream(TEST_PUBLIC_KEY, { maxPolls: 1 });
    const { value } = await stream.next();

    expect(value?.status).toBe("ok");
    if (value?.status === "ok") {
      expect(value.data.transactions[0]?.hash).toBe("tx_client");
    }
  });
});
