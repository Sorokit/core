import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { getAssetCreationSteps, prepareAssetForIssuing, validateAssetCode } from "./assetCreationHelper";

const issuer = Keypair.random().publicKey();

describe("assetCreationHelper", () => {
  it("lists ordered steps and rejects bad issuers", () => {
    const r = getAssetCreationSteps(issuer);
    expect(r.status === "ok" && r.data.map((s) => s.order)).toEqual([1, 2, 3, 4, 5]);
    expect(getAssetCreationSteps("bad").status).toBe("error");
  });

  it.each(["A", "USDC", "ABCDEFGHIJKL"])("accepts %s", (code) => {
    expect(validateAssetCode(code).status).toBe("ok");
  });
  it.each(["", "ABCDEFGHIJKLM", "US-DC"])("rejects %s", (code) => {
    expect(validateAssetCode(code).status).toBe("error");
  });

  it("builds presets with optional issuer flags", () => {
    const plain = prepareAssetForIssuing("USDC", issuer);
    const flagged = prepareAssetForIssuing("USDC", issuer, { authRequired: true, authRevocable: true });
    if (plain.status !== "ok" || flagged.status !== "ok") throw new Error("preset failed");
    expect(plain.data.issuerOperations).toHaveLength(0);
    expect(flagged.data.issuerOperations).toHaveLength(1);
    expect(plain.data.distributorOperations("100")[0].body().switch().name).toBe("changeTrust");
    expect(prepareAssetForIssuing("US DC", issuer).status).toBe("error");
  });
});
