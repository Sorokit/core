import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockFunction, spyOn } from "./mockAbstraction";

type RunnerGlobals = typeof globalThis & {
  vi?: typeof vi;
  jest?: typeof vi;
};

const globals = globalThis as RunnerGlobals;
const runner = { fn: vi.fn, spyOn: vi.spyOn };
const originalVi = globals.vi;
const originalJest = globals.jest;

afterEach(() => {
  globals.vi = originalVi;
  globals.jest = originalJest;
});

describe("mock abstraction", () => {
  it("uses Vitest when it is available", () => {
    globals.vi = runner;
    globals.jest = undefined;

    const mock = createMockFunction(() => "result");

    expect(mock()).toBe("result");
    expect(mock.mock.calls).toHaveLength(1);
  });

  it("falls back to Jest when Vitest is unavailable", () => {
    globals.vi = undefined;
    globals.jest = runner;

    const mock = createMockFunction(() => "result");

    expect(mock()).toBe("result");
  });

  it("provides a runner-neutral spyOn helper", () => {
    globals.vi = runner;

    const target = { value: () => "original" };
    const spy = spyOn(target, "value");
    spy.mockReturnValue("mocked");

    expect(target.value()).toBe("mocked");
    expect(spy).toHaveBeenCalledOnce();
  });

  it("reports a useful error without a supported runner", () => {
    globals.vi = undefined;
    globals.jest = undefined;

    expect(() => createMockFunction()).toThrow(/Vitest or Jest/);
  });
});