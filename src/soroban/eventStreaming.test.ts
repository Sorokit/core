import { describe, it, expect, vi } from "vitest";
import { streamContractEvents, type ContractEvent } from "./eventStreaming";

describe("Contract Event Stream (#990)", () => {
  const TEST_CONTRACT = "CA3D5KRYMCMCZVAC7OHQEZ2KTCQIWBGX7XTNXMAJM3SMHQWBP3JTVDAR";

  const sampleEvent: ContractEvent = {
    contractId: TEST_CONTRACT,
    type: "contract",
    ledger: 1000,
    ledgerClosedAt: new Date().toISOString(),
    topic: ["transfer", "USDC"],
    value: 500,
    id: "evt_1",
  };

  it("streams contract events and applies topic filters", () => {
    const res = streamContractEvents(TEST_CONTRACT, {
      filter: { topics: ["transfer"] },
    });
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      const stream = res.data;
      const listener = vi.fn();
      stream.onEvent(listener);

      stream.pushEvent(sampleEvent);
      expect(listener).toHaveBeenCalledWith(sampleEvent);

      // Event not matching topic filter
      const otherEvent: ContractEvent = {
        ...sampleEvent,
        id: "evt_2",
        topic: ["mint"],
      };
      stream.pushEvent(otherEvent);
      expect(listener).toHaveBeenCalledTimes(1);
    }
  });

  it("validates empty contractId", () => {
    const res = streamContractEvents("");
    expect(res.status).toBe("error");
  });
});
