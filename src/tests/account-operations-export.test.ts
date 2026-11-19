import { describe, it, expect, vi, beforeEach } from "vitest";
import { SorokitErrorCode } from "../shared/response";
import type { GetOperationsOptions, OperationsPage } from "../account/types";

// ─── Hoisted mock refs ────────────────────────────────────────────────────────

const { mockCall, mockForAccount, mockLimit, mockOrder, mockCursor } =
  vi.hoisted(() => ({
    mockCall: vi.fn(),
    mockForAccount: vi.fn(),
    mockLimit: vi.fn(),
    mockOrder: vi.fn(),
    mockCursor: vi.fn(),
  }));

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();

  class MockOperationsBuilder {
    forAccount(...args: any[]) { mockForAccount(...args); return this; }
    limit(...args: any[]) { mockLimit(...args); return this; }
    order(...args: any[]) { mockOrder(...args); return this; }
    cursor(...args: any[]) { mockCursor(...args); return this; }
    includeFailed(...args: any[]) { return this; }
    call(...args: any[]) { return mockCall(...args); }
  }

  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: vi.fn().mockImplementation(() => ({
        operations: () => new MockOperationsBuilder(),
      })),
    },
  };
});

import { createSorokitClient } from "../client/createSorokitClient";
import * as publicApi from "../index";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PUBLIC_KEY = "GBTABBLFJWSIJKGRVJMOV477L42GXCHFHGDUOCDMC7MXWASTPZKQNB25";
const SOURCE_ACCOUNT = "GAAL6LIAG2FGFQTKMUNGLCSCAM722PPYRVK2PXEMC6KNRRWLCFTYQD7R";

function record(): Record<string, unknown> {
  return {
    id: "op-1",
    paging_token: "100",
    source_account: SOURCE_ACCOUNT,
    type: "payment",
    created_at: "2024-06-01T12:00:00Z",
    transaction_hash: "hash-1",
    transaction_successful: true,
  };
}

function client() {
  const result = createSorokitClient({ network: "testnet" });
  if (result.status !== "ok") throw new Error("client creation failed");
  return result.data;
}

// ─── Tests (#912) ─────────────────────────────────────────────────────────────

describe("account operations query is publicly exported (#912)", () => {
  beforeEach(() => {
    mockCall.mockReset();
    mockForAccount.mockReset();
    mockLimit.mockReset();
    mockOrder.mockReset();
    mockCursor.mockReset();
  });

  it("exports the getOperations function and its types from the package entry point", () => {
    expect(typeof publicApi.getOperations).toBe("function");
    // Compile-time proof that the option/result types are part of the public API.
    const filters: GetOperationsOptions = { type: "payment", limit: 5 };
    const check = (page: OperationsPage): number => page.operations.length;
    expect(typeof check).toBe("function");
    expect(filters.type).toBe("payment");
  });

  it("exposes client.account.getAccountOperations with the requested signature", () => {
    expect(typeof client().account.getAccountOperations).toBe("function");
  });

  it("fetches operations from Horizon with type, cursor, limit and order filters", async () => {
    mockCall.mockResolvedValue({ records: [record()] });

    const result = await client().account.getAccountOperations(PUBLIC_KEY, {
      type: "payment",
      cursor: "99",
      limit: 7,
      order: "asc",
    });

    expect(mockForAccount).toHaveBeenCalledWith(PUBLIC_KEY);
    expect(mockLimit).toHaveBeenCalledWith(7);
    expect(mockOrder).toHaveBeenCalledWith("asc");
    expect(mockCursor).toHaveBeenCalledWith("99");
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.operations).toHaveLength(1);
    expect(result.data.nextCursor).toBe("100");
  });

  it("includes the operation source account in each result", async () => {
    mockCall.mockResolvedValue({ records: [record()] });

    const result = await client().account.getAccountOperations(PUBLIC_KEY);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.operations[0]?.sourceAccount).toBe(SOURCE_ACCOUNT);
  });

  it("propagates Horizon errors as a SorokitResult rather than throwing", async () => {
    mockCall.mockRejectedValue(new Error("horizon down"));

    const result = await client().account.getAccountOperations(PUBLIC_KEY);

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.error.code).toBe(SorokitErrorCode.ACCOUNT_FETCH_FAILED);
  });
});
