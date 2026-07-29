import { describe, expect, it } from "vitest";
import {
  decodeContractEvent,
  type ContractEventDecoder,
} from "../soroban/decodeContractEvent";

describe("contract event decoders", () => {
  it("decodes factory pair creation", () => {
    const result = decodeContractEvent({
      contractId: "CFACTORY",
      name: "pair_created",
      value: ["TOKEN_A", "TOKEN_B", "CPAIR"],
    });
    expect(result).toMatchObject({
      type: "factory.pair_created",
      data: { tokenA: "TOKEN_A", tokenB: "TOKEN_B", pair: "CPAIR" },
    });
  });

  it("decodes router swaps", () => {
    const result = decodeContractEvent({
      contractId: "CROUTER",
      topics: ["router", "swap"],
      value: ["GSENDER", ["A", "B", "C"], 100n, 95n],
    });
    expect(result).toMatchObject({
      type: "router.swap",
      data: { sender: "GSENDER", path: ["A", "B", "C"], amountIn: "100", amountOut: "95" },
    });
  });

  it("allows custom decoders to take precedence without changing the API", () => {
    const custom: ContractEventDecoder = (event) =>
      event.name === "future" ? { type: "custom.future", contractId: "", data: 1, raw: event } : null;
    expect(decodeContractEvent({ name: "future" }, [custom])?.type).toBe("custom.future");
  });
});
