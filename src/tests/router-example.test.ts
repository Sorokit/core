/**
 * Tests for the frontend router integration example (#357) —
 * `examples/router-swap/src/routerSwap.ts`.
 *
 * The example is a reference implementation, so it is verified the same way a
 * consumer would experience it: the real SDK code runs end to end and only
 * Horizon is faked, via `vi.mock("../shared/serverFactory")`. That keeps the
 * example honest — quote decoding, slippage bounds, signing, submission, and
 * status polling all execute the code an integrator would copy.
 */

import { Account, Keypair } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SorokitErrorCode, ok, err } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { clearReplayProtection } from "../transaction/submitTransaction";
import { WalletType } from "../wallet/types";
import type { SignTransactionInput, WalletAdapter } from "../wallet/types";
import {
  applySlippage,
  createRouterSwapClient,
  formatQuote,
} from "../../examples/router-swap/src/routerSwap";
import type { RouterSwapClient, SwapRequest } from "../../examples/router-swap/src/routerSwap";

// ---------------------------------------------------------------------------
// Fake Horizon
// ---------------------------------------------------------------------------

const {
  mockLoadAccount,
  mockStrictSendPaths,
  mockStrictReceivePaths,
  mockSubmit,
  mockTransactionCall,
} = vi.hoisted(() => ({
  mockLoadAccount: vi.fn(),
  mockStrictSendPaths: vi.fn(),
  mockStrictReceivePaths: vi.fn(),
  mockSubmit: vi.fn(),
  mockTransactionCall: vi.fn(),
}));

vi.mock("../shared/serverFactory", () => ({
  createHorizonServer: vi.fn(() => ({
    loadAccount: mockLoadAccount,
    strictSendPaths: mockStrictSendPaths,
    strictReceivePaths: mockStrictReceivePaths,
    submitTransaction: mockSubmit,
    transactions: vi.fn(() => ({
      transaction: vi.fn(() => ({ call: mockTransactionCall })),
    })),
  })),
  createSorobanServer: vi.fn(),
  setTracedFetch: vi.fn(),
  getTracedFetch: vi.fn(),
  setSorobanSimulator: vi.fn(),
}));

const source = Keypair.random().publicKey();
const issuer = Keypair.random().publicKey();
const usdc = { code: "USDC", issuer };
const eurc = { code: "EURC", issuer };

/** Horizon path record with a single USDC hop. */
function pathRecord(overrides: Record<string, unknown> = {}) {
  return {
    destination_amount: "24.1500000",
    source_amount: "100.0000000",
    path: [
      {
        asset_type: "credit_alphanum4",
        asset_code: usdc.code,
        asset_issuer: usdc.issuer,
      },
    ],
    ...overrides,
  };
}

function pathsResponse(records: unknown[]) {
  return { call: vi.fn().mockResolvedValue({ records }) };
}

/** A wallet that signs by handing the XDR straight back. */
function fakeWallet(
  behaviour: (input: SignTransactionInput) => Promise<SorokitResult<string>> = async (
    input,
  ) => ok(input.transactionXdr),
): WalletAdapter {
  return {
    walletType: WalletType.FREIGHTER,
    isAvailable: () => true,
    connect: async () => ok(source),
    disconnect: async () => ok(undefined),
    signTransaction: behaviour,
  };
}

function baseRequest(overrides: Partial<SwapRequest> = {}): SwapRequest {
  return {
    sourcePublicKey: source,
    destination: source,
    sendAsset: { code: "XLM" },
    receiveAsset: eurc,
    mode: "strict-send",
    amount: "100",
    ...overrides,
  };
}

function createClient(): RouterSwapClient {
  const created = createRouterSwapClient({ network: "testnet" });
  if (created.status === "error") {
    throw new Error(`Router client failed: ${created.error.message}`);
  }
  return created.data;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearReplayProtection();
  mockLoadAccount.mockResolvedValue(new Account(source, "1"));
  mockStrictSendPaths.mockReturnValue(pathsResponse([pathRecord()]));
  mockStrictReceivePaths.mockReturnValue(pathsResponse([pathRecord()]));
});

// ---------------------------------------------------------------------------
// Quote
// ---------------------------------------------------------------------------

describe("router example — getQuote", () => {
  it("prices a strict-send swap and reports the discovered route", async () => {
    const result = await createClient().getQuote(baseRequest());

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.route).toEqual(["XLM", "USDC", "EURC"]);
    expect(result.data.sendAmount).toBe("100.0000000");
    expect(result.data.receiveAmount).toBe("24.1500000");
    expect(result.data.transactionXdr.length).toBeGreaterThan(0);
  });

  it("lowers the minimum received by the slippage tolerance", async () => {
    const result = await createClient().getQuote(
      baseRequest({ slippageTolerancePercent: 1 }),
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    // 24.1500000 quoted − 1% → 23.9085000 enforced on-chain.
    expect(result.data.slippageBound).toBe("23.9085000");
    expect(result.data.slippageTolerancePercent).toBe(1);
  });

  it("raises the maximum spent for a strict-receive swap", async () => {
    const result = await createClient().getQuote(
      baseRequest({ mode: "strict-receive", slippageTolerancePercent: 2 }),
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    // 100.0000000 quoted + 2% → the user accepts spending up to 102 XLM.
    expect(result.data.slippageBound).toBe("102.0000000");
  });

  it("keeps the quoted bound when tolerance is zero", async () => {
    const result = await createClient().getQuote(
      baseRequest({ slippageTolerancePercent: 0 }),
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.slippageBound).toBe("24.1500000");
    // Only the discovery build runs — no rebuild is needed.
    expect(mockStrictSendPaths).toHaveBeenCalledTimes(1);
  });

  it("rebuilds the transaction over the route it quoted", async () => {
    const result = await createClient().getQuote(baseRequest());

    expect(result.status).toBe("ok");
    // Discovery queries Horizon; the rebuild reuses the returned path, so no
    // second path query is issued.
    expect(mockStrictSendPaths).toHaveBeenCalledTimes(1);
    expect(mockLoadAccount).toHaveBeenCalledTimes(2);
  });

  it("rejects a swap between the same asset before calling Horizon", async () => {
    const result = await createClient().getQuote(
      baseRequest({ sendAsset: usdc, receiveAsset: usdc }),
    );

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.error.code).toBe(SorokitErrorCode.ROUTER_INVALID_PATH);
    expect(mockStrictSendPaths).not.toHaveBeenCalled();
  });

  it.each([["abc"], ["-5"], ["1.123456789"], [""]])(
    "rejects the amount %s with an actionable message",
    async (amount) => {
      const result = await createClient().getQuote(baseRequest({ amount }));

      expect(result.status).toBe("error");
      if (result.status !== "error") return;
      expect(result.error.code).toBe(SorokitErrorCode.INVALID_CONFIG);
      expect(result.error.message).toContain("decimal places");
    },
  );

  it("rejects an out-of-range slippage tolerance", async () => {
    const result = await createClient().getQuote(
      baseRequest({ slippageTolerancePercent: 120 }),
    );

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.error.code).toBe(SorokitErrorCode.INVALID_CONFIG);
  });

  it("maps an empty order book to a router-specific error code", async () => {
    mockStrictSendPaths.mockReturnValue(pathsResponse([]));

    const result = await createClient().getQuote(baseRequest());

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.error.code).toBe(SorokitErrorCode.ROUTER_INVALID_PATH);
    expect(result.error.message).toContain("No path found");
  });

  it("surfaces a Horizon outage as a router failure", async () => {
    mockLoadAccount.mockRejectedValue(new Error("connect ECONNREFUSED"));

    const result = await createClient().getQuote(baseRequest());

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.error.code).toBe(SorokitErrorCode.ROUTER_SWAP_FAILED);
  });
});

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

describe("router example — executeSwap", () => {
  async function quoteFor(request: SwapRequest = baseRequest()) {
    const router = createClient();
    const quote = await router.getQuote(request);
    if (quote.status !== "ok") throw new Error("Quote failed");
    return { router, quote: quote.data };
  }

  it("signs, submits, and confirms a swap", async () => {
    const { router, quote } = await quoteFor();
    mockSubmit.mockResolvedValue({ hash: "abc123", ledger: 42 });
    mockTransactionCall.mockResolvedValue({
      hash: "abc123",
      successful: true,
      ledger_attr: 42,
      created_at: "2026-01-01T00:00:00Z",
      fee_charged: 100,
    });

    const steps: string[] = [];
    const result = await router.executeSwap(quote, fakeWallet(), source, {
      pollIntervalMs: 0,
      onProgress: (step) => steps.push(step),
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.hash).toBe("abc123");
    expect(result.data.transaction.status).toBe("success");
    expect(steps).toEqual(["signing", "submitting", "confirming"]);
  });

  it("keeps polling while the transaction is not yet in a ledger", async () => {
    const { router, quote } = await quoteFor();
    mockSubmit.mockResolvedValue({ hash: "abc123", ledger: 42 });
    mockTransactionCall
      .mockResolvedValueOnce({ hash: "abc123", successful: true, fee_charged: 100 })
      .mockResolvedValue({
        hash: "abc123",
        successful: true,
        ledger_attr: 42,
        fee_charged: 100,
      });

    const result = await router.executeSwap(quote, fakeWallet(), source, {
      pollIntervalMs: 0,
    });

    expect(result.status).toBe("ok");
    expect(mockTransactionCall).toHaveBeenCalledTimes(2);
  });

  it("reports a transaction that failed on-chain as a router failure", async () => {
    const { router, quote } = await quoteFor();
    mockSubmit.mockResolvedValue({ hash: "abc123", ledger: 42 });
    mockTransactionCall.mockResolvedValue({
      hash: "abc123",
      successful: false,
      ledger_attr: 42,
      fee_charged: 100,
    });

    const result = await router.executeSwap(quote, fakeWallet(), source, {
      pollIntervalMs: 0,
    });

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.error.code).toBe(SorokitErrorCode.ROUTER_SWAP_FAILED);
    expect(result.error.message).toContain("slippage bound");
  });

  it("propagates a wallet rejection without rewriting it as a router error", async () => {
    const { router, quote } = await quoteFor();
    const rejecting = fakeWallet(async () =>
      err<string>(SorokitErrorCode.WALLET_SIGN_REJECTED, "User declined."),
    );

    const result = await router.executeSwap(quote, rejecting, source, {
      pollIntervalMs: 0,
    });

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.error.code).toBe(SorokitErrorCode.WALLET_SIGN_REJECTED);
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it("maps a rejected submission to a router error", async () => {
    const { router, quote } = await quoteFor();
    mockSubmit.mockRejectedValue(new Error("op_underfunded: insufficient liquidity"));

    const result = await router.executeSwap(quote, fakeWallet(), source, {
      pollIntervalMs: 0,
    });

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.error.code).toBe(SorokitErrorCode.ROUTER_INSUFFICIENT_LIQUIDITY);
  });

  it("stops polling after the configured number of attempts", async () => {
    const { router, quote } = await quoteFor();
    mockSubmit.mockResolvedValue({ hash: "abc123", ledger: 42 });
    mockTransactionCall.mockRejectedValue(new Error("not found"));

    const result = await router.executeSwap(quote, fakeWallet(), source, {
      pollAttempts: 3,
      pollIntervalMs: 0,
    });

    // Submission succeeded, so the swap is reported as sent even though the
    // status lookup never resolved.
    expect(result.status).toBe("ok");
    expect(mockTransactionCall).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe("router example — helpers", () => {
  it.each([
    ["100", 0.5, "lower", "99.5000000"],
    ["100", 0.5, "raise", "100.5000000"],
    ["24.15", 1, "lower", "23.9085000"],
    ["0.0000010", 50, "lower", "0.0000005"],
  ] as const)(
    "applySlippage(%s, %s%, %s) → %s",
    (amount, tolerance, direction, expected) => {
      expect(applySlippage(amount, tolerance, direction)).toBe(expected);
    },
  );

  it("returns null for an unparsable amount", () => {
    expect(applySlippage("abc", 1, "lower")).toBeNull();
  });

  it("formats a quote for display", () => {
    const text = formatQuote({
      transactionXdr: "AAAA",
      mode: "strict-send",
      sendAmount: "100.0000000",
      receiveAmount: "24.1500000",
      slippageBound: "23.9085000",
      slippageTolerancePercent: 1,
      route: ["XLM", "USDC", "EURC"],
      feeStroops: "100",
    });

    expect(text).toBe(
      "100.0000000 XLM → 24.1500000 EURC via XLM → USDC → EURC (min 23.9085000, fee 100 stroops)",
    );
  });

  it("rejects an unknown network", () => {
    const created = createRouterSwapClient({
      network: "moonnet" as never,
    });

    expect(created.status).toBe("error");
    if (created.status !== "error") return;
    expect(created.error.code).toBe(SorokitErrorCode.INVALID_NETWORK);
  });
});
