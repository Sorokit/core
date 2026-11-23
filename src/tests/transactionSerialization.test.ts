import { describe, it, expect } from "vitest";
import {
  Keypair,
  Account,
  TransactionBuilder,
  Networks,
  Operation,
  Asset,
} from "@stellar/stellar-sdk";
import {
  encodeTransaction,
  decodeTransaction,
} from "../transaction/serialization";

describe("transaction serialization (#958)", () => {
  const sourceKey = Keypair.random();
  const destKey = Keypair.random();
  const account = new Account(sourceKey.publicKey(), "100");

  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: destKey.publicKey(),
        asset: Asset.native(),
        amount: "10",
      }),
    )
    .setTimeout(30)
    .build();

  tx.sign(sourceKey);

  it("encodes a transaction to base64 XDR", () => {
    const result = encodeTransaction(tx);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(typeof result.data).toBe("string");
      expect(result.data.length).toBeGreaterThan(0);
    }
  });

  it("decodes a base64 XDR string back into a transaction", () => {
    const encoded = encodeTransaction(tx);
    expect(encoded.status).toBe("ok");
    if (encoded.status === "ok") {
      const decoded = decodeTransaction(encoded.data, Networks.TESTNET);
      expect(decoded.status).toBe("ok");
      if (decoded.status === "ok") {
        expect(decoded.data.source).toBe(sourceKey.publicKey());
      }
    }
  });

  it("preserves data on roundtrip serialization", () => {
    const encoded1 = encodeTransaction(tx);
    expect(encoded1.status).toBe("ok");
    if (encoded1.status === "ok") {
      const decoded = decodeTransaction(encoded1.data, Networks.TESTNET);
      expect(decoded.status).toBe("ok");
      if (decoded.status === "ok") {
        const encoded2 = encodeTransaction(decoded.data);
        expect(encoded2.status).toBe("ok");
        if (encoded2.status === "ok") {
          expect(encoded2.data).toBe(encoded1.data);
        }
      }
    }
  });

  it("returns error for invalid input", () => {
    const result = decodeTransaction("invalid-base-64!");
    expect(result.status).toBe("error");

    const encodeResult = encodeTransaction(null as any);
    expect(encodeResult.status).toBe("error");
  });
});
