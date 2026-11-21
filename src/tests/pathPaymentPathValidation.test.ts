import { Keypair, Networks } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { SorokitErrorCode } from "../shared/response";
import { buildPathPayment } from "../transaction/buildTransaction";
import {
  buildPathPaymentTransaction,
  MAX_PATH_PAYMENT_INTERMEDIATE_ASSETS,
  validatePathPaymentPathLength,
} from "../transaction/pathPayment";

const issuer = Keypair.random().publicKey();
const source = Keypair.random().publicKey();
const destination = Keypair.random().publicKey();
const network = {
  horizonUrl: "https://example.invalid",
  networkPassphrase: Networks.TESTNET,
  sorobanRpcUrl: "https://example.invalid",
};

const baseParams = {
  destination,
  sendAssetCode: "XLM",
  destAssetCode: "USDC",
  destAssetIssuer: issuer,
  amount: "100",
  mode: "strict-send" as const,
  sequenceNumber: "1",
  estimatedFee: "100",
  slippageAmount: "95",
};

function intermediateAssets(count: number) {
  return Array.from({ length: count }, () => ({
    assetCode: "USDC",
    assetIssuer: issuer,
  }));
}

describe("path payment path length validation", () => {
  it("requires at least one intermediate asset when a path is provided", async () => {
    const result = await buildPathPayment(network.horizonUrl, network, source, {
      ...baseParams,
      path: [],
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.ROUTER_INVALID_PATH);
      expect(result.error.message).toContain("at least one intermediate asset");
    }
  });

  it("rejects paths longer than the Stellar maximum", async () => {
    const result = await buildPathPayment(network.horizonUrl, network, source, {
      ...baseParams,
      path: intermediateAssets(MAX_PATH_PAYMENT_INTERMEDIATE_ASSETS + 1),
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.ROUTER_INVALID_PATH);
      expect(result.error.message).toContain(
        `more than ${MAX_PATH_PAYMENT_INTERMEDIATE_ASSETS}`,
      );
    }
  });

  it("validates path length in buildPathPaymentTransaction", async () => {
    const result = await buildPathPaymentTransaction({
      sourcePublicKey: source,
      destination,
      sendAssetCode: "XLM",
      sendAssetIssuer: null,
      destAssetCode: "USDC",
      destAssetIssuer: issuer,
      amount: "100",
      mode: "strict-send",
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.ROUTER_INVALID_PATH);
      expect(result.error.message).toContain("at least one intermediate asset");
    }
  });

  it("allows empty paths only when the caller opts into direct conversions", () => {
    expect(validatePathPaymentPathLength(0).status).toBe("error");
    expect(validatePathPaymentPathLength(0, { allowEmpty: true }).status).toBe(
      "ok",
    );
    expect(validatePathPaymentPathLength(1).status).toBe("ok");
    expect(
      validatePathPaymentPathLength(MAX_PATH_PAYMENT_INTERMEDIATE_ASSETS)
        .status,
    ).toBe("ok");
  });
});
