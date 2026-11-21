import { beforeEach, describe, expect, it, vi } from "vitest";
import { nativeToScVal } from "@stellar/stellar-sdk";

const rpc = { getContractData: vi.fn(), getLedgerEntries: vi.fn() };
vi.mock("../shared/serverFactory", () => ({ createSorobanServer: () => rpc }));

import { getContractData, getContractStorage } from "./stateQueries";
import { generateInterface } from "./interfaceGenerator";
import { buildABI } from "./abiParser";
import type { ContractMethod } from "./types";

const methods: ContractMethod[] = [
  {
    name: "transfer",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "i128" },
    ],
    returnType: null,
  },
  { name: "ids", inputs: [{ name: "owner", type: "address" }], returnType: "vec<u32>" },
];

describe("contract state queries", () => {
  beforeEach(() => vi.clearAllMocks());
  it("decodes a stored value", async () => {
    rpc.getContractData.mockResolvedValue({
      val: { contractData: () => ({ val: () => nativeToScVal(7, { type: "u32" }) }) },
    });
    const r = await getContractData("http://rpc", "CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K", nativeToScVal("k"));
    expect(r.status === "ok" && r.data).toBe(7);
  });
  it("returns an error when the entry is missing", async () => {
    rpc.getContractData.mockRejectedValue(new Error("not found"));
    const r = await getContractData("http://rpc", "C1", nativeToScVal("k"));
    expect(r.status).toBe("error");
  });
  it("returns an error when the contract instance is missing", async () => {
    rpc.getLedgerEntries.mockResolvedValue({ entries: [] });
    const r = await getContractStorage("http://rpc", "CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K");
    expect(r.status).toBe("error");
  });
});

describe("ABI parsing and interface generation", () => {
  it("builds an ABI from methods", () => {
    const r = buildABI(methods);
    expect(r.status === "ok" && r.data.methods[0]?.returns).toBe("void");
  });
  it("rejects duplicate method names", () => {
    expect(buildABI([methods[0]!, methods[0]!]).status).toBe("error");
  });
  it("generates a typed interface", () => {
    const r = buildABI(methods);
    if (r.status !== "ok") throw new Error("parse failed");
    const src = generateInterface(r.data, "Token");
    expect(src).toContain("transfer(to: string, amount: bigint): Promise<void>;");
    expect(src).toContain("ids(owner: string): Promise<Array<number>>;");
  });
});
