import { describe, it, expect, vi } from "vitest";
import { ContractInteractionBuilder, createContractInteractionBuilder } from "../soroban/contractInteractionBuilder";
import type { ContractMethod } from "../soroban/types";

const MOCK_METHODS: ContractMethod[] = [
  {
    name: "hello",
    inputs: [{ name: "to", type: "symbol" }],
    returnType: "symbol",
  },
  {
    name: "add",
    inputs: [
      { name: "a", type: "u32" },
      { name: "b", type: "u32" },
    ],
    returnType: "u32",
  },
  {
    name: "store",
    inputs: [
      { name: "key", type: "string" },
      { name: "value", type: "string" },
    ],
    returnType: "void",
  },
  {
    name: "transfer",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "i128" },
    ],
    returnType: "i128",
  },
];

describe("ContractInteractionBuilder", () => {
  it("creates instance with default state", () => {
    const builder = new ContractInteractionBuilder({ rpcUrl: "https://rpc.test" });
    expect(builder.state.contractId).toBeNull();
    expect(builder.state.contractIdValid).toBe(false);
    expect(builder.state.methods).toEqual([]);
    expect(builder.state.selectedMethod).toBeNull();
    expect(builder.state.loading).toBe(false);
  });

  it("creates instance with contract ID", () => {
    const builder = new ContractInteractionBuilder({
      rpcUrl: "https://rpc.test",
      contractId: "CDLZJ7ZJ7VZX5QFXQT4Q6J7ZJ7VZX5QFXQT4Q6J7ZJ7VZX5Q",
    });
    expect(builder.state.contractId).toBeTruthy();
  });

  it("setContractId validates format", () => {
    const builder = new ContractInteractionBuilder({ rpcUrl: "https://rpc.test" });
    const result = builder.setContractId("invalid");
    expect(result.status).toBe("error");
    expect(builder.state.contractIdValid).toBe(false);
    expect(builder.state.contractIdError).toContain("Invalid");
  });

  it("setContractId accepts a valid contract ID", () => {
    const builder = new ContractInteractionBuilder({ rpcUrl: "https://rpc.test" });
    const validId = "CDLZJ7ZJ7VZX5QFXQT4Q6J7ZJ7VZX5QFXQT4Q6J7ZJ7VZX5Q";
    const result = builder.setContractId(validId);
    expect(result.status).toBe("ok");
    expect(builder.state.contractIdValid).toBe(true);
  });

  it("setContractId with empty string fails", () => {
    const builder = new ContractInteractionBuilder({ rpcUrl: "https://rpc.test" });
    const result = builder.setContractId("");
    expect(result.status).toBe("error");
  });

  it("loadMethods fails without valid contract ID", async () => {
    const builder = new ContractInteractionBuilder({ rpcUrl: "https://rpc.test" });
    const result = await builder.loadMethods();
    expect(result.status).toBe("error");
  });

  it("selectMethod returns argument fields for the method", () => {
    const builder = new ContractInteractionBuilder({ rpcUrl: "https://rpc.test" });
    (builder as any)._state.methods = MOCK_METHODS;
    const result = builder.selectMethod(1);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.method.name).toBe("add");
      expect(result.data.arguments.length).toBe(2);
      expect(result.data.arguments[0].name).toBe("a");
      expect(result.data.arguments[0].type).toBe("u32");
      expect(result.data.arguments[1].name).toBe("b");
    }
  });

  it("selectMethod returns error for invalid index", () => {
    const builder = new ContractInteractionBuilder({ rpcUrl: "https://rpc.test" });
    const result = builder.selectMethod(-1);
    expect(result.status).toBe("error");
  });

  it("selectMethod sets argument defaults", () => {
    const builder = new ContractInteractionBuilder({ rpcUrl: "https://rpc.test" });
    (builder as any)._state.methods = MOCK_METHODS;
    builder.selectMethod(0);
    expect(builder.state.arguments.to).toBe("");
    builder.selectMethod(1);
    expect(builder.state.arguments.a).toBe(0);
    expect(builder.state.arguments.b).toBe(0);
  });

  it("setArgument updates argument value", () => {
    const builder = new ContractInteractionBuilder({ rpcUrl: "https://rpc.test" });
    (builder as any)._state.methods = MOCK_METHODS;
    builder.selectMethod(1);
    builder.setArgument("a", 42);
    expect(builder.state.arguments.a).toBe(42);
  });

  it("setArgumentError sets error for an argument", () => {
    const builder = new ContractInteractionBuilder({ rpcUrl: "https://rpc.test" });
    (builder as any)._state.methods = MOCK_METHODS;
    builder.selectMethod(1);
    builder.setArgumentError("a", "Must be positive");
    expect(builder.state.argumentErrors.a).toBe("Must be positive");
  });

  it("validateArguments returns true when all valid", () => {
    const builder = new ContractInteractionBuilder({ rpcUrl: "https://rpc.test" });
    (builder as any)._state.methods = MOCK_METHODS;
    builder.selectMethod(1);
    builder.setArgument("a", 10);
    builder.setArgument("b", 20);
    expect(builder.validateArguments()).toBe(true);
    expect(builder.state.validationErrors.length).toBe(0);
  });

  it("validateArguments returns false when arguments are invalid", () => {
    const builder = new ContractInteractionBuilder({ rpcUrl: "https://rpc.test" });
    (builder as any)._state.methods = MOCK_METHODS;
    builder.selectMethod(0);
    // symbol type expects non-empty string, default is empty string
    builder.setArgument("to", "");
    expect(builder.validateArguments()).toBe(false);
    expect(builder.state.validationErrors.length).toBeGreaterThan(0);
  });

  it("validateArguments validates address format", () => {
    const builder = new ContractInteractionBuilder({ rpcUrl: "https://rpc.test" });
    (builder as any)._state.methods = MOCK_METHODS;
    builder.selectMethod(3);
    builder.setArgument("from", "invalid");
    builder.setArgument("to", "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA");
    builder.setArgument("amount", 1000);
    expect(builder.validateArguments()).toBe(false);
    expect(builder.state.argumentErrors.from).toContain("valid Stellar address");
  });

  it("generateCallCode fails without selected method", () => {
    const builder = new ContractInteractionBuilder({ rpcUrl: "https://rpc.test" });
    const result = builder.generateCallCode();
    expect(result.status).toBe("error");
  });

  it("generateCallCode produces JavaScript code", () => {
    const builder = new ContractInteractionBuilder({
      rpcUrl: "https://rpc.test",
      contractId: "CDLZJ7ZJ7VZX5QFXQT4Q6J7ZJ7VZX5QFXQT4Q6J7ZJ7VZX5Q",
    });
    (builder as any)._state.methods = MOCK_METHODS;
    builder.selectMethod(0);
    builder.setArgument("to", "world");
    const result = builder.generateCallCode();
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.javascript).toContain('method: "hello"');
      expect(result.data.javascript).toContain("world");
      expect(result.data.typescript).toContain("createSorokitClient");
      expect(result.data.json).toContain("hello");
    }
  });

  it("generateCallCode produces JSON preview", () => {
    const builder = new ContractInteractionBuilder({
      rpcUrl: "https://rpc.test",
      contractId: "CDLZJ7ZJ7VZX5QFXQT4Q6J7ZJ7VZX5QFXQT4Q6J7ZJ7VZX5Q",
    });
    (builder as any)._state.methods = MOCK_METHODS;
    builder.selectMethod(2);
    builder.setArgument("key", "name");
    builder.setArgument("value", "alice");
    const result = builder.generateCallCode();
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.json).toContain("name");
      expect(result.data.json).toContain("alice");
    }
  });

  it("reset clears method selection but keeps contract ID", () => {
    const builder = new ContractInteractionBuilder({
      rpcUrl: "https://rpc.test",
      contractId: "CDLZJ7ZJ7VZX5QFXQT4Q6J7ZJ7VZX5QFXQT4Q6J7ZJ7VZX5Q",
    });
    (builder as any)._state.methods = MOCK_METHODS;
    builder.selectMethod(0);
    expect(builder.state.selectedMethod).not.toBeNull();
    builder.reset();
    expect(builder.state.selectedMethod).toBeNull();
    expect(builder.state.contractId).toBeTruthy();
  });

  it("resetAll clears everything", () => {
    const builder = new ContractInteractionBuilder({
      rpcUrl: "https://rpc.test",
      contractId: "CDLZJ7ZJ7VZX5QFXQT4Q6J7ZJ7VZX5QFXQT4Q6J7ZJ7VZX5Q",
    });
    (builder as any)._state.methods = MOCK_METHODS;
    builder.selectMethod(0);
    builder.resetAll();
    expect(builder.state.contractId).toBeNull();
    expect(builder.state.selectedMethod).toBeNull();
    expect(builder.state.methods).toEqual([]);
  });

  it("subscribe and unsubscribe works", () => {
    const builder = new ContractInteractionBuilder({ rpcUrl: "https://rpc.test" });
    const listener = vi.fn();
    const unsub = builder.subscribe(listener);
    builder.setContractId("CDLZJ7ZJ7VZX5QFXQT4Q6J7ZJ7VZX5QFXQT4Q6J7ZJ7VZX5Q");
    expect(listener).toHaveBeenCalled();
    unsub();
    listener.mockClear();
    builder.setContractId("CDLZJ7ZJ7VZX5QFXQT4Q6J7ZJ7VZX5QFXQT4Q6J7ZJ7VZX5Q");
    expect(listener).not.toHaveBeenCalled();
  });

  it("provides method list via getter", () => {
    const builder = new ContractInteractionBuilder({ rpcUrl: "https://rpc.test" });
    (builder as any)._state.methods = MOCK_METHODS;
    expect(builder.methods.length).toBe(4);
  });

  it("provides selected method via getter", () => {
    const builder = new ContractInteractionBuilder({ rpcUrl: "https://rpc.test" });
    (builder as any)._state.methods = MOCK_METHODS;
    builder.selectMethod(2);
    expect(builder.selectedMethod?.name).toBe("store");
  });

  it("placeholder reflects type", () => {
    const builder = new ContractInteractionBuilder({ rpcUrl: "https://rpc.test" });
    (builder as any)._state.methods = MOCK_METHODS;
    const result = builder.selectMethod(3);
    if (result.status === "ok") {
      expect(result.data.arguments[0].placeholder).toBe("G... or C...");
      expect(result.data.arguments[1].placeholder).toBe("G... or C...");
      expect(result.data.arguments[2].placeholder).toBe("0");
    }
  });
});

describe("createContractInteractionBuilder (#759)", () => {
  it("returns a ContractInteractionBuilder instance", () => {
    const builder = createContractInteractionBuilder({ rpcUrl: "https://rpc.test" });
    expect(builder).toBeInstanceOf(ContractInteractionBuilder);
  });

  it("initial state has no contract ID and no methods", () => {
    const builder = createContractInteractionBuilder({ rpcUrl: "https://rpc.test" });
    expect(builder.state.contractId).toBeNull();
    expect(builder.state.methods).toEqual([]);
    expect(builder.state.loading).toBe(false);
  });

  it("accepts an optional contractId in config", () => {
    const builder = createContractInteractionBuilder({
      rpcUrl: "https://rpc.test",
      contractId: "CDLZJ7ZJ7VZX5QFXQT4Q6J7ZJ7VZX5QFXQT4Q6J7ZJ7VZX5Q",
    });
    expect(builder.state.contractId).toBeTruthy();
  });

  it("state transitions via setContractId are observable", () => {
    const builder = createContractInteractionBuilder({ rpcUrl: "https://rpc.test" });
    const listener = vi.fn();
    const unsub = builder.subscribe(listener);
    builder.setContractId("CDLZJ7ZJ7VZX5QFXQT4Q6J7ZJ7VZX5QFXQT4Q6J7ZJ7VZX5Q");
    expect(listener).toHaveBeenCalledOnce();
    unsub();
  });
});
