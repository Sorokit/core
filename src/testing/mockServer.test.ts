import { afterEach, describe, expect, it } from "vitest";
import { setResponseMode, setupMockServer, teardownMockServer } from "./mockServer";

describe("mock server response modes", () => {
  afterEach(() => teardownMockServer());

  it("simulates a fee surge for transaction simulation", async () => {
    setupMockServer();
    setResponseMode("fee_surge");

    const response = await fetch("https://mock.test/simulateTransaction", { method: "POST" });
    const body = await response.json() as { minResourceFee: string };

    expect(body.minResourceFee).toBe("1000");
  });

  it("simulates rate limits and degraded service", async () => {
    setupMockServer();
    setResponseMode("rate_limited");
    expect((await fetch("https://mock.test/sendTransaction", { method: "POST" })).status).toBe(429);

    setResponseMode("degraded");
    expect((await fetch("https://mock.test/sendTransaction", { method: "POST" })).status).toBe(503);
  });
});
