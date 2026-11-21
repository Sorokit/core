import { describe, expect, it } from "vitest";
import { err, ok, SorokitErrorCode } from "../shared/response";
import { createRetryPolicy } from "./retryPolicy";

describe("createRetryPolicy", () => {
  it("retries with exponential delays and stops on success", async () => {
    const delays: number[] = [];
    const policy = createRetryPolicy({ maxAttempts: 3, baseDelayMs: 10, sleep: async (ms) => { delays.push(ms); } });
    let calls = 0;
    await expect(policy(async () => ++calls < 3 ? err(SorokitErrorCode.NETWORK_ERROR, "temporary") : ok("done"))).resolves.toMatchObject({ status: "ok", data: "done" });
    expect(delays).toEqual([10, 20]);
  });
});
