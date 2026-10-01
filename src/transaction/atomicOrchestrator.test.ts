import { describe, expect, it, vi } from "vitest";
import { err, SorokitErrorCode } from "../shared/response";
import { orchestrate } from "./atomicOrchestrator";

describe("atomic transaction orchestration", () => {
  it("executes steps in order and returns their results", async () => {
    const order: string[] = [];
    const result = await orchestrate()
      .step(async () => {
        order.push("swap");
        return "swapped";
      })
      .step(async ({ results }) => {
        order.push("deposit");
        expect(results).toEqual(["swapped"]);
        return "deposited";
      })
      .execute();

    expect(order).toEqual(["swap", "deposit"]);
    expect(result).toMatchObject({
      status: "ok",
      data: {
        completedSteps: 2,
        results: ["swapped", "deposited"],
        attemptsByStep: [1, 1],
      },
    });
  });

  it("runs compensation after a partial failure", async () => {
    const rollback = vi.fn();
    const result = await orchestrate()
      .step(() => "swapped")
      .step(() => {
        throw new Error("deposit failed");
      })
      .onFailure(rollback)
      .execute();

    expect(rollback).toHaveBeenCalledWith(
      expect.objectContaining({
        completedSteps: 1,
        failedStepIndex: 1,
        results: ["swapped"],
        failure: expect.any(Error),
      }),
    );
    expect(result.status).toBe("error");
  });

  it("retries the failed step without repeating completed steps", async () => {
    const firstStep = vi.fn(() => "ready");
    const secondStep = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValue("done");

    const result = await orchestrate({ maxRetries: 1 })
      .step(firstStep)
      .step(secondStep)
      .execute();

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.attemptsByStep).toEqual([1, 2]);
    }
    expect(firstStep).toHaveBeenCalledTimes(1);
    expect(secondStep).toHaveBeenCalledTimes(2);
  });

  it("treats an error SorokitResult as a failed step", async () => {
    const rollback = vi.fn();
    const result = await orchestrate()
      .step(() => err(SorokitErrorCode.TX_SUBMIT_FAILED, "step failed"))
      .onFailure(rollback)
      .execute();

    expect(result.status).toBe("error");
    expect(rollback).toHaveBeenCalledWith(expect.objectContaining({ failedStepIndex: 0 }));
  });
});