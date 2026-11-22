import { describe, expect, it, vi } from "vitest";
import { createRateLimitTracker, executeWithTimeout } from "../network";

describe("rate-limit tracking (#1008)", () => {
  it("tracks requests, headers, remaining quota, and low-quota warnings", () => {
    const warning = vi.fn();
    const tracker = createRateLimitTracker({ warningThreshold: 0.1, onWarning: warning });
    tracker.recordRequest("horizon");
    const usage = tracker.recordResponse("horizon", { "X-RateLimit-Limit": "100", "X-RateLimit-Remaining": "5" });
    expect(usage.requests).toBe(1);
    expect(usage.responses).toBe(1);
    expect(tracker.getRemainingRequests("horizon")).toBe(5);
    expect(warning).toHaveBeenCalledOnce();
  });
});

describe("request timeout handling (#1007)", () => {
  it("returns a typed timeout and aborts the operation", async () => {
    let aborted = false;
    const result = await executeWithTimeout((signal) => new Promise<string>(() => {
      signal.addEventListener("abort", () => { aborted = true; });
    }), 5);
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error.code).toBe("OPERATION_TIMEOUT");
    expect(aborted).toBe(true);
  });
});
