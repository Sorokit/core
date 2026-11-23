import { describe, it, expect } from "vitest";
import {
  Keypair,
  Account,
  TransactionBuilder,
  Networks,
  Operation,
  Asset,
} from "@stellar/stellar-sdk";
import { validateTransaction } from "../transaction/validation";

describe("transaction preflight validation (#959)", () => {
  const sourceKey = Keypair.random();
  const destKey = Keypair.random();

  function buildValidTx() {
    const account = new Account(sourceKey.publicKey(), "1000");
    const tx = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: destKey.publicKey(),
          asset: Asset.native(),
          amount: "5",
        }),
      )
      .setTimeout(30)
      .build();
    tx.sign(sourceKey);
    return tx;
  }

  it("validates a properly structured and signed transaction", () => {
    const tx = buildValidTx();
    const result = validateTransaction(tx);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.valid).toBe(true);
      expect(result.data.errors).toHaveLength(0);
    }
  });

  it("detects missing signatures", () => {
    const account = new Account(sourceKey.publicKey(), "1000");
    const tx = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: destKey.publicKey(),
          asset: Asset.native(),
          amount: "5",
        }),
      )
      .setTimeout(30)
      .build();
    // Do not sign
    const result = validateTransaction(tx);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.valid).toBe(false);
      expect(result.data.errors.some((e) => e.field === "signers")).toBe(true);
    }
  });

  it("detects invalid sequence numbers", () => {
    const tx = buildValidTx();
    (tx as any).sequence = "0";
    const result = validateTransaction(tx);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.valid).toBe(false);
      expect(result.data.errors.some((e) => e.field === "sequence")).toBe(true);
    }
  });

  it("detects insufficient fees", () => {
    const tx = buildValidTx();
    (tx as any).fee = 50; // Less than 100 stroops min fee
    const result = validateTransaction(tx);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.valid).toBe(false);
      expect(result.data.errors.some((e) => e.field === "fee")).toBe(true);
    }
  });

  it("detects invalid source account", () => {
    const tx = buildValidTx();
    (tx as any).source = "INVALID_PUBLIC_KEY";
    const result = validateTransaction(tx);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.valid).toBe(false);
      expect(result.data.errors.some((e) => e.field === "source")).toBe(true);
    }
  });
});
