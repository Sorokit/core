import { describe, expect, it, vi } from "vitest";
import { createLogger } from "./logger";
import { createOperationDebugger } from "./operationDebug";

describe("createOperationDebugger", () => {
  it("tags entries with operation id, strips query strings, and redacts secrets", () => {
    const sink = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const d = createOperationDebugger(createLogger({ logLevel: "debug", logger: sink }), "submit");
    d.log("built", { secret: "SABC" });
    d.network("request", "https://h.example/tx?key=1");
    const [msg, meta] = sink.debug.mock.calls[0];
    expect(msg).toContain(d.operationId);
    expect(meta.secret).toBe("[redacted]");
    expect(sink.debug.mock.calls[1][0]).toBe(`[${d.operationId}] network request https://h.example/tx`);
  });

  it("is silent when debug is off", () => {
    const sink = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    createOperationDebugger(createLogger({ logger: sink }), "x").log("hidden");
    expect(sink.debug).not.toHaveBeenCalled();
  });
});
