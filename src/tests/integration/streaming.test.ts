import { describe, it, expect, vi } from "vitest";
import { createSorokitClient } from "../../client/createSorokitClient";

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  
  const mockServer = {
    loadAccount: vi.fn()
      .mockResolvedValueOnce({
        sequence: "123",
        subentry_count: 0,
        balances: [
          { asset_type: "native", balance: "0.0" }
        ]
      })
      .mockResolvedValueOnce({
        sequence: "123",
        subentry_count: 0,
        balances: [
          { asset_type: "native", balance: "5.0" }
        ]
      }),
  };

  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: vi.fn(() => mockServer),
    },
  };
});

describe("Integration: Account Streaming", () => {
  it("streams account events and maps them to alerts", async () => {
    const clientResult = createSorokitClient({ network: "testnet" });
    expect(clientResult.status).toBe("ok");
    if (clientResult.status !== "ok") return;
    const client = clientResult.data;

    const onBalanceChangeSpy = vi.fn();
    const onAlertSpy = vi.fn();

    const stream = client.account.stream(
      "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
      {
        intervalMs: 1000,
        minIntervalMs: 1000,
        maxPolls: 2,
        onBalanceChange: onBalanceChangeSpy,
        onAlert: onAlertSpy,
        alertRules: [
          {
            id: "above-zero",
            assetCode: "XLM",
            assetIssuer: null,
            condition: "above",
            threshold: 1.0,
          }
        ]
      }
    );

    const events = [];
    for await (const result of stream) {
      if (result.status === "ok") {
        events.push(result.data);
      }
    }

    expect(events).toHaveLength(2);
    expect(events[0].balances[0].balance).toBe("0.0");
    expect(events[1].balances[0].balance).toBe("5.0");

    expect(onBalanceChangeSpy).toHaveBeenCalledOnce();
    expect(onBalanceChangeSpy).toHaveBeenCalledWith("XLM", "0.0", "5.0");

    expect(onAlertSpy).toHaveBeenCalledOnce();
    expect(onAlertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        assetCode: "XLM",
        assetIssuer: null,
        oldBalance: "0.0",
        newBalance: "5.0",
        changePercent: null,
        rule: expect.objectContaining({
          id: "above-zero",
          assetCode: "XLM",
          assetIssuer: null,
          condition: "above",
          threshold: 1,
        }),
      }),
    );
  });
});
