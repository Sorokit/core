import { describe, expect, it, vi } from "vitest";
import { initiateDeposit, initiateWithdraw, trackTransaction } from "./sep6Flow";

const ASSET = { code: "USDC" };

describe("initiateWithdraw", () => {
  it("accepts a valid positive decimal amount", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "tx1" }), { status: 200 }),
    );

    const result = await initiateWithdraw("example.com", ASSET, { amount: "10.5", fetch: fetcher });

    expect(result.status).toBe("ok");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("accepts a withdrawal with no amount specified at all", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "tx1" }), { status: 200 }),
    );

    const result = await initiateWithdraw("example.com", ASSET, { fetch: fetcher });

    expect(result.status).toBe("ok");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects a zero amount before making any network call", async () => {
    const fetcher = vi.fn();

    const result = await initiateWithdraw("example.com", ASSET, { amount: "0", fetch: fetcher });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toMatch(/positive/);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a negative amount before making any network call", async () => {
    const fetcher = vi.fn();

    const result = await initiateWithdraw("example.com", ASSET, { amount: "-100", fetch: fetcher });

    expect(result.status).toBe("error");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a NaN amount before making any network call", async () => {
    const fetcher = vi.fn();

    const result = await initiateWithdraw("example.com", ASSET, {
      amount: "not-a-number",
      fetch: fetcher,
    });

    expect(result.status).toBe("error");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects an infinite amount before making any network call", async () => {
    const fetcher = vi.fn();

    const result = await initiateWithdraw("example.com", ASSET, { amount: "Infinity", fetch: fetcher });

    expect(result.status).toBe("error");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects an asset without a code before validating the amount", async () => {
    const fetcher = vi.fn();

    const result = await initiateWithdraw("example.com", { code: "" }, {
      amount: "-5",
      fetch: fetcher,
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toMatch(/asset code/i);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("initiateDeposit", () => {
  // initiateDeposit shares Sep6FlowRequestOptions with initiateWithdraw but
  // is not in scope for #783 — the issue names withdrawal specifically, and
  // a deposit amount means something different (how much the user intends
  // to deposit, which the anchor itself quotes/validates in its own flow).
  // This test pins that deposit's own request still works unaffected.
  it("is unaffected by the withdrawal amount validation added for #783", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "tx1" }), { status: 200 }),
    );

    const result = await initiateDeposit("example.com", ASSET, { amount: "0", fetch: fetcher });

    expect(result.status).toBe("ok");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("trackTransaction", () => {
  it("rejects an empty transaction id without making a request", async () => {
    const fetcher = vi.fn();

    const result = await trackTransaction("example.com", "", { fetch: fetcher });

    expect(result.status).toBe("error");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
