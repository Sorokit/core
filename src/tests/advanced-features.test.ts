import { webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { xdr } from "@stellar/stellar-sdk";
import {
  analyzeArgumentEncoding,
  buildOptimizedSplitPaymentPlan,
  captureContractState,
  createClaimCommitment,
  createProofEnvelope,
  diffContractState,
  inspectContractInvocation,
  optimizeContractArgs,
  verifyProof,
} from "../index";

globalThis.crypto ??= webcrypto as Crypto;

describe("contract state snapshots", () => {
  it("classifies added, removed, and changed entries deterministically", async () => {
    const before = await captureContractState("C123", async () => [
      { key: "b", value: "2" },
      { key: "a", value: "1" },
    ]);
    const after = await captureContractState("C123", async () => [
      { key: "a", value: "updated" },
      { key: "c", value: "3" },
    ]);

    const diff = diffContractState(before, after);
    expect(diff.changes.map((change) => [change.kind, change.key])).toEqual([
      ["changed", "a"],
      ["removed", "b"],
      ["added", "c"],
    ]);
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.changed).toBe(1);
  });

  it("captures the state transition around an invocation", async () => {
    let value = "before";
    const inspected = await inspectContractInvocation(
      "C123",
      async () => [{ key: "value", value }],
      async () => {
        value = "after";
        return 42;
      },
    );
    expect(inspected.result).toBe(42);
    expect(inspected.diff.changes[0]?.kind).toBe("changed");
  });
});

describe("contract argument optimization", () => {
  it("reuses repeated encoded ScVals while preserving argument count", () => {
    const repeated = xdr.ScVal.scvU32(7);
    const optimized = optimizeContractArgs([repeated, repeated, xdr.ScVal.scvU32(8)]);
    expect(optimized.args).toHaveLength(3);
    expect(optimized.args[0]).toBe(optimized.args[1]);
    expect(analyzeArgumentEncoding([repeated, repeated]).repeatedValues).toBe(1);
  });
});

describe("multi-path split execution", () => {
  const route = (name: string) => ({
    source: { code: name, issuer: null },
    destination: { code: "USD", issuer: "GISSUER" },
    path: [],
    price: "1",
  });

  it("fills the cheapest routes first and respects capacities", () => {
    const result = buildOptimizedSplitPaymentPlan([
      { route: route("slow"), maxDestinationAmount: "60", sourceAmount: "60" },
      { route: route("fast"), maxDestinationAmount: "40", sourceAmount: "36" },
    ], "80");

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.legs.map((leg) => leg.destinationAmount)).toEqual(["40", "40"]);
      expect(result.data.totalSourceAmount).toBe("76");
    }
  });

  it("returns insufficient-liquidity errors when quotes cannot fill the target", () => {
    const result = buildOptimizedSplitPaymentPlan([
      { route: route("only"), maxDestinationAmount: "2", sourceAmount: "2" },
    ], "3");
    expect(result.status).toBe("error");
  });
});

describe("zero-knowledge proof infrastructure", () => {
  it("creates stable commitments for claim orderings", async () => {
    const first = await createClaimCommitment({ amount: "10", asset: "USDC" });
    const second = await createClaimCommitment({ asset: "USDC", amount: "10" });
    expect(first).toBe(second);
  });

  it("delegates proof verification without exposing witness data", async () => {
    const statement = { type: "payment-limit", publicInputs: { max: "100" } };
    const envelope = createProofEnvelope("mock", statement, "proof-bytes", {
      claims: { asset: "USDC" },
      commitment: "commitment",
    });
    const verifier = { verify: vi.fn(async (context) => context.proof === "proof-bytes") };
    const result = await verifyProof(envelope, verifier);
    expect(result.valid).toBe(true);
    expect(verifier.verify).toHaveBeenCalledOnce();
  });
});
