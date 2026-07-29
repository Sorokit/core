import { describe, expect, it } from "vitest";
import { SorokitErrorCode } from "../shared/response";
import {
  describeRouterSwapFailure,
  findSwapPath,
} from "../transaction/pathPayment";

describe("router swap errors", () => {
  it.each([
    ["invalid route path", SorokitErrorCode.ROUTER_INVALID_PATH],
    ["pool has insufficient liquidity", SorokitErrorCode.ROUTER_INSUFFICIENT_LIQUIDITY],
    ["minimum amount failed due to slippage", SorokitErrorCode.ROUTER_SLIPPAGE_EXCEEDED],
    ["contract invocation failed", SorokitErrorCode.ROUTER_SWAP_FAILED],
  ])("maps %s to a descriptive code", (message, code) => {
    expect(describeRouterSwapFailure(new Error(message)).code).toBe(code);
  });

  it("returns a router-specific error for a same-asset route", async () => {
    const asset = { code: "USDC", issuer: "GISSUER" };
    const result = await findSwapPath(asset, asset);

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.ROUTER_INVALID_PATH);
      expect(result.error.message).toContain("source and destination");
    }
  });
});
