import { describe, expect, it } from "vitest";
import { ok } from "../shared/response";
import { createConcurrencyLimiter } from "./concurrencyLimiter";

describe("createConcurrencyLimiter", () => {
  it("runs no more than the configured number concurrently", async () => {
    const limiter = createConcurrencyLimiter(2);
    let active = 0;
    let peak = 0;
    const task = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return ok(true);
    };
    await Promise.all(Array.from({ length: 5 }, () => limiter(task)));
    expect(peak).toBe(2);
  });
});
