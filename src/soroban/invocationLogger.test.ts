import { describe, expect, it } from "vitest";
import { createInvocationLogger } from "./invocationLogger";

describe("createInvocationLogger", () => {
  it("captures successful calls and duration", async () => {
    const logger = createInvocationLogger();
    await expect(logger.log("CABC", "balance", [{ token: "secret" }], async () => 3)).resolves.toBe(3);
    expect(logger.entries()[0]).toMatchObject({ contractId: "CABC", method: "balance", result: 3, status: "success" });
    expect(logger.entries()[0]?.args[0]).toEqual({ token: "[redacted]" });
  });
});
