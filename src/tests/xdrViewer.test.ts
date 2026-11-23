import { describe, it, expect } from "vitest";
import {
  Keypair,
  Account,
  TransactionBuilder,
  Networks,
  Operation,
  Asset,
} from "@stellar/stellar-sdk";
import { formatXDR } from "../utilities/xdrViewer";

describe("xdr viewer (#961)", () => {
  const sourceKey = Keypair.random();
  const destKey = Keypair.random();
  const account = new Account(sourceKey.publicKey(), "1000");

  const tx = new TransactionBuilder(account, {
    fee: "150",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: destKey.publicKey(),
        asset: Asset.native(),
        amount: "25.5",
      }),
    )
    .addMemo({
      type: "text",
      value: "Test memo string",
    } as any)
    .setTimeout(60)
    .build();

  tx.sign(sourceKey);

  it("formats a Transaction instance into human-readable text", () => {
    const formatted = formatXDR(tx);
    expect(formatted).toContain("STELLAR TRANSACTION");
    expect(formatted).toContain("Standard Transaction");
    expect(formatted).toContain(sourceKey.publicKey());
    expect(formatted).toContain("1000"); // Sequence
    expect(formatted).toContain("150 stroops"); // Fee
    expect(formatted).toContain("PAYMENT");
    expect(formatted).toContain(destKey.publicKey());
    expect(formatted).toContain("25.5");
  });

  it("formats a base64 XDR string into human-readable text", () => {
    const xdr = tx.toXDR();
    const formatted = formatXDR(xdr, Networks.TESTNET);
    expect(formatted).toContain("STELLAR TRANSACTION");
    expect(formatted).toContain(sourceKey.publicKey());
    expect(formatted).toContain("PAYMENT");
  });

  it("handles malformed XDR gracefully without throwing", () => {
    const formatted = formatXDR("not-valid-xdr");
    expect(formatted).toContain("Error");
  });
});
