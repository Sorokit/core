import {
  Keypair,
  Networks,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { buildPathPayment } from "../transaction/buildTransaction";

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
  destAssetCode: "EURC",
  destAssetIssuer: issuer,
  amount: "100",
  sequenceNumber: "1",
  estimatedFee: "100",
  path: [
    { assetCode: "USDC", assetIssuer: issuer },
    { assetCode: "BTC", assetIssuer: issuer },
  ],
} as const;

function firstOperation(xdr: string) {
  return TransactionBuilder.fromXDR(xdr, Networks.TESTNET).operations[0];
}

describe("router multi-hop swap integration", () => {
  it("builds a strict-send swap with two intermediate pools and a minimum output", async () => {
    const result = await buildPathPayment("", network, source, {
      ...baseParams,
      mode: "strict-send",
      slippageAmount: "95",
      path: [...baseParams.path],
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const operation = firstOperation(result.data);
      expect(operation.type).toBe("pathPaymentStrictSend");
      if (operation.type === "pathPaymentStrictSend") {
        expect(operation.path.map((asset) => asset.code)).toEqual(["USDC", "BTC"]);
        expect(operation.sendAmount).toBe("100.0000000");
        expect(operation.destMin).toBe("95.0000000");
      }
    }
  });

  it("builds a strict-receive route with a maximum input slippage bound", async () => {
    const result = await buildPathPayment("", network, source, {
      ...baseParams,
      mode: "strict-receive",
      slippageAmount: "105",
      path: [...baseParams.path],
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const operation = firstOperation(result.data);
      expect(operation.type).toBe("pathPaymentStrictReceive");
      if (operation.type === "pathPaymentStrictReceive") {
        expect(operation.path).toHaveLength(2);
        expect(operation.destAmount).toBe("100.0000000");
        expect(operation.sendMax).toBe("105.0000000");
      }
    }
  });

  it("rejects an invalid intermediate asset before building an XDR", async () => {
    const result = await buildPathPayment("", network, source, {
      ...baseParams,
      mode: "strict-send",
      slippageAmount: "95",
      path: [{ assetCode: "USDC" }],
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("issuer");
    }
  });
});
