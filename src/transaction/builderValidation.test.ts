import { describe, expect, it } from "vitest";
import { createTransactionBuilderSchema, validateTransactionBuilder } from "./builderValidation";

describe("transaction builder validation", () => {
  it("validates required fields and constraints", () => {
    const schema = createTransactionBuilderSchema({
      destination: { required: true, type: "string", min: 3 },
      amount: { required: true, type: "string", pattern: /^\d+(\.\d+)?$/ },
    });
    expect(validateTransactionBuilder({ type: "payment", params: { destination: "GABC", amount: "2" } }, schema).status).toBe("ok");
    expect(validateTransactionBuilder({ type: "payment", params: { amount: "bad" } }, schema).status).toBe("error");
  });
});
