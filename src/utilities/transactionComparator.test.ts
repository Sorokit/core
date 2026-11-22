import { describe, it, expect } from "vitest";
import { compareTxs } from "./transactionComparator";

describe("Transaction Comparator (#1003)", () => {
  const txA = {
    sourceAccount: "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ",
    fee: "100",
    sequenceNumber: "12345",
    memoType: "text",
    memoValue: "hello",
    operations: [
      { type: "payment", destination: "GBB...", amount: "10" },
    ],
    signatures: ["sig1"],
  };

  const txB = {
    sourceAccount: "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ",
    fee: "200",
    sequenceNumber: "12345",
    memoType: "text",
    memoValue: "hello updated",
    operations: [
      { type: "payment", destination: "GBB...", amount: "15" },
      { type: "changeTrust", line: "USDC" },
    ],
    signatures: ["sig1", "sig2"],
  };

  it("detects identical transactions", () => {
    const res = compareTxs(txA, { ...txA, operations: [...txA.operations] });
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.data.identical).toBe(true);
      expect(res.data.changesSummary.length).toBe(0);
    }
  });

  it("detects differences in fees, memo, operations, and signatures", () => {
    const res = compareTxs(txA, txB);
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.data.identical).toBe(false);
      expect(res.data.differences.fee?.delta).toBe(100);
      expect(res.data.differences.operationsCount?.tx2).toBe(2);
      expect(res.data.differences.signaturesCount?.tx2).toBe(2);
      expect(res.data.differences.memo).toBeDefined();
      expect(res.data.changesSummary.length).toBeGreaterThan(0);
    }
  });

  it("returns validation error when missing transaction", () => {
    const res = compareTxs(null, txB);
    expect(res.status).toBe("error");
  });
});
