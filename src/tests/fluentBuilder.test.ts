import { describe, expect, it } from "vitest";
import { createTransactionBuilder } from "../transaction/transactionBuilder";
import { compose } from "../transaction/compose";

describe("Transaction Builder Fluent API (#955)", () => {
  it("supports method chaining on TransactionBuilder", () => {
    const builder = createTransactionBuilder();

    const ops = builder
      .setSourceAccount("GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFDAGORAc4SGS7N7M6K")
      .setFee(200)
      .setMemo("chain-test")
      .setTimeout(60)
      .setNetwork("testnet")
      .setSequenceNumber("123")
      .addOperation({
        type: "payment",
        params: { destination: "GDEST", amount: "10" },
      })
      .addOperation({
        type: "trustline",
        params: { assetCode: "USDC" },
      })
      .build();

    expect(ops.length).toBe(2);
    expect(builder.getSourceAccount()).toBe("GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFDAGORAc4SGS7N7M6K");
    expect(builder.getFee()).toBe(200);
    expect(builder.getMemo()).toBe("chain-test");
    expect(builder.getTimeout()).toBe(60);
    expect(builder.getNetwork()).toBe("testnet");
    expect(builder.getSequenceNumber()).toBe("123");
  });

  it("supports chaining setter methods on ComposeBuilder", () => {
    const builder = compose("GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFDAGORAc4SGS7N7M6K", "testnet")
      .setFee("150")
      .setMemo("memo-fluent")
      .setTimeout(45)
      .setSequenceNumber("999")
      .setSourceAccount("GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFDAGORAc4SGS7N7M6K");

    expect(typeof builder.build).toBe("function");
    expect(typeof builder.addPayment).toBe("function");
  });
});
