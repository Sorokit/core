import { describe, expect, it } from "vitest";
import { TransactionGroupBuilder, createTransactionGroupBuilder } from "../transaction/groupBuilder";
import { Transaction, Account, Operation, Asset, Keypair, Networks } from "@stellar/stellar-sdk";

describe("Transaction Group Builder (#956)", () => {
  const kp = Keypair.random();
  const sourceAccount = new Account(kp.publicKey(), "100");

  function makeMockTx(seq: string): Transaction {
    return {
      sequence: seq,
      operations: [],
      source: kp.publicKey(),
    } as unknown as Transaction;
  }

  it("groups transactions and manages sequence numbers", () => {
    const builder = createTransactionGroupBuilder({ baseSequence: "500" });

    const tx1 = makeMockTx("100");
    const tx2 = makeMockTx("100");
    const tx3 = makeMockTx("100");

    const result = builder
      .addTransaction(tx1)
      .addTransaction(tx2)
      .addTransaction(tx3)
      .build();

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.length).toBe(3);
      expect(result.data[0]?.sequence).toBe("500");
      expect(result.data[1]?.sequence).toBe("501");
      expect(result.data[2]?.sequence).toBe("502");
    }
  });

  it("handles empty groups gracefully", () => {
    const builder = new TransactionGroupBuilder();
    const result = builder.build();

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.length).toBe(0);
    }
  });

  it("handles various group sizes and clear/addTransactions", () => {
    const builder = createTransactionGroupBuilder({ baseSequence: "10" });
    const batch = [makeMockTx("1"), makeMockTx("2"), makeMockTx("3"), makeMockTx("4")];

    builder.addTransactions(batch);
    expect(builder.size()).toBe(4);

    const res = builder.build();
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.data[3]?.sequence).toBe("13");
    }

    builder.clear();
    expect(builder.size()).toBe(0);
  });
});
