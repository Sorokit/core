import { describe, expect, it, vi } from "vitest";
import {
  MAX_OPERATIONS,
  RECOMMENDED_MAX_OPERATIONS,
  RECOMMENDED_MAX_BYTES,
  TransactionSizeTracker,
} from "./transactionSizeTracker";

function makeLogger() {
  return { warn: vi.fn() };
}

describe("TransactionSizeTracker (#858)", () => {
  it("tracks operation count as operations are added", () => {
    const tracker = new TransactionSizeTracker();
    expect(tracker.snapshot().operationCount).toBe(0);

    tracker.addOperation("payment", { amount: "100" });
    tracker.addOperation("payment", { amount: "200" });

    expect(tracker.snapshot().operationCount).toBe(2);
  });

  it("increases the estimated byte size as operations with larger payloads are added", () => {
    const tracker = new TransactionSizeTracker();
    const before = tracker.snapshot().estimatedBytes;

    const after = tracker.addOperation("manageData", {
      name: "a-fairly-long-data-entry-name",
      value: "x".repeat(200),
    });

    expect(after.estimatedBytes).toBeGreaterThan(before);
  });

  it("warns once the recommended operation count is exceeded, logging via the configured logger", () => {
    const logger = makeLogger();
    const tracker = new TransactionSizeTracker({ logger, recommendedMaxOperations: 3 });

    tracker.addOperation("payment");
    tracker.addOperation("payment");
    const atLimit = tracker.addOperation("payment");
    expect(atLimit.warnings).toHaveLength(0);
    expect(logger.warn).not.toHaveBeenCalled();

    const overLimit = tracker.addOperation("payment");
    expect(overLimit.warnings.some((w) => w.code === "OPERATION_COUNT_ABOVE_RECOMMENDED")).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("warns when the protocol hard limit of operations is exceeded, with a distinct warning code", () => {
    const logger = makeLogger();
    const tracker = new TransactionSizeTracker({ logger, recommendedMaxOperations: MAX_OPERATIONS });

    let last;
    for (let i = 0; i < MAX_OPERATIONS + 1; i += 1) {
      last = tracker.addOperation("payment");
    }

    expect(last?.operationCount).toBe(MAX_OPERATIONS + 1);
    expect(last?.warnings.some((w) => w.code === "OPERATION_COUNT_EXCEEDS_LIMIT")).toBe(true);
  });

  it("warns when the estimated size crosses the recommended byte threshold", () => {
    const logger = makeLogger();
    const tracker = new TransactionSizeTracker({ logger, recommendedMaxBytes: 500 });

    const first = tracker.addOperation("manageData", { value: "x".repeat(100) });
    expect(first.warnings).toHaveLength(0);

    const second = tracker.addOperation("manageData", { value: "x".repeat(600) });
    expect(second.warnings.some((w) => w.code === "ESTIMATED_SIZE_ABOVE_RECOMMENDED")).toBe(true);
  });

  it("does not repeat the same warning code once it has already fired", () => {
    const logger = makeLogger();
    const tracker = new TransactionSizeTracker({ logger, recommendedMaxOperations: 1 });

    tracker.addOperation("payment");
    tracker.addOperation("payment");
    tracker.addOperation("payment");

    // The warning code is present every time the condition still holds, but
    // the underlying logger should only have been called once per code.
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("reset() clears both the operation count and any previously emitted warning state", () => {
    const logger = makeLogger();
    const tracker = new TransactionSizeTracker({ logger, recommendedMaxOperations: 1 });

    tracker.addOperation("payment");
    tracker.addOperation("payment");
    expect(logger.warn).toHaveBeenCalledTimes(1);

    tracker.reset();
    expect(tracker.snapshot().operationCount).toBe(0);

    tracker.addOperation("payment");
    tracker.addOperation("payment");
    // The warning fires again after reset, since warnedCodes was cleared too.
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("uses console.warn by default when no logger is passed", () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const tracker = new TransactionSizeTracker({ recommendedMaxOperations: 1 });
      tracker.addOperation("payment");
      tracker.addOperation("payment");
      expect(consoleSpy).toHaveBeenCalledTimes(1);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("exposes the documented default thresholds", () => {
    expect(MAX_OPERATIONS).toBe(100);
    expect(RECOMMENDED_MAX_OPERATIONS).toBeLessThan(MAX_OPERATIONS);
    expect(RECOMMENDED_MAX_BYTES).toBeGreaterThan(0);
  });
});
