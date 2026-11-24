import { describe, expect, it } from "vitest";
import { createSandbox } from "../soroban/sandbox";

describe("contract sandbox (#1053)", () => {
  it("deploys contracts and creates unique contract IDs", () => {
    const sandbox = createSandbox();
    const first = sandbox.deployContract(new Uint8Array([0, 97, 115, 109]));
    const second = sandbox.deployContract(new Uint8Array([0, 97, 115, 109]));

    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    expect(first.data?.contractId).toBeTypeOf("string");
    expect(second.data?.contractId).not.toBe(first.data?.contractId);
  });

  it("rejects empty WASM bytes", () => {
    const sandbox = createSandbox();
    expect(sandbox.deployContract(new Uint8Array()).status).toBe("error");
  });

  it("invokes contracts and persists state", () => {
    const sandbox = createSandbox();
    const deployed = sandbox.deployContract(new Uint8Array([1, 2, 3]));
    expect(deployed.status).toBe("ok");
    const contractId = deployed.data?.contractId as string;

    expect(
      sandbox.invokeContract(contractId, "set", ["balance", 42]).status,
    ).toBe("ok");

    const state = sandbox.getContractState(contractId);
    expect(state.status).toBe("ok");
    expect(state.data?.state).toEqual({ balance: 42 });

    const value = sandbox.invokeContract(contractId, "get", ["balance"]);
    expect(value.status).toBe("ok");
    expect(value.data?.result).toBe(42);
  });

  it("returns errors for unknown contracts", () => {
    const sandbox = createSandbox();
    expect(sandbox.invokeContract("missing", "get").status).toBe("error");
    expect(sandbox.getContractState("missing").status).toBe("error");
  });
});
