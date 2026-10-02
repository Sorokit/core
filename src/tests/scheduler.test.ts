import { describe, it, expect, vi } from "vitest";
import {
  scheduleTransaction,
  cancelSchedule,
  getSchedule,
  listSchedules,
  processDueSchedules,
  InMemoryScheduleStore,
  type SchedulerConfig,
} from "../transaction/scheduler";

function createConfig(
  overrides: Partial<SchedulerConfig> = {},
): SchedulerConfig {
  return {
    store: new InMemoryScheduleStore(),
    ...overrides,
  };
}

describe("transaction scheduler", () => {
  describe("scheduleTransaction", () => {
    it("creates a one-time schedule", () => {
      const config = createConfig();
      const result = scheduleTransaction(
        { op: "payment", dest: "GABC" },
        Date.now() + 60_000,
        null,
        config,
      );

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        const sched = config.store.get(result.data.scheduleId)!;
        expect(sched).toBeDefined();
        expect(sched.status).toBe("pending");
        expect(sched.recurrenceMs).toBeNull();
        expect(sched.payload).toEqual({ op: "payment", dest: "GABC" });
      }
    });

    it("creates a recurring schedule", () => {
      const config = createConfig();
      const result = scheduleTransaction(
        { op: "payment" },
        Date.now() + 1000,
        30_000,
        config,
      );

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        const sched = config.store.get(result.data.scheduleId)!;
        expect(sched.recurrenceMs).toBe(30_000);
      }
    });

    it("rejects one-time schedule with past executeAt", () => {
      const config = createConfig();
      const result = scheduleTransaction(
        { op: "test" },
        Date.now() - 1000,
        null,
        config,
      );

      expect(result.status).toBe("error");
    });
  });

  describe("cancelSchedule", () => {
    it("cancels a pending schedule", () => {
      const config = createConfig();
      const res = scheduleTransaction(
        { op: "test" },
        Date.now() + 60_000,
        null,
        config,
      );
      const id = (res.status === "ok" ? res.data.scheduleId : "") as string;

      const cancelResult = cancelSchedule(id, config);
      expect(cancelResult.status).toBe("ok");
      expect(config.store.get(id)!.status).toBe("cancelled");
    });

    it("rejects cancelling a non-existent schedule", () => {
      const config = createConfig();
      const result = cancelSchedule("nonexistent", config);
      expect(result.status).toBe("error");
    });

    it("rejects cancelling an already-executed schedule", () => {
      const config = createConfig();
      const res = scheduleTransaction(
        { op: "test" },
        Date.now() + 60_000,
        null,
        config,
      );
      const id = (res.status === "ok" ? res.data.scheduleId : "") as string;

      // Mark as executed
      const sched = config.store.get(id)!;
      sched.status = "executed";
      config.store.save(sched);

      const cancelResult = cancelSchedule(id, config);
      expect(cancelResult.status).toBe("error");
    });
  });

  describe("getSchedule / listSchedules", () => {
    it("retrieves a schedule by id", () => {
      const config = createConfig();
      const res = scheduleTransaction(
        { op: "test" },
        Date.now() + 60_000,
        null,
        config,
      );
      const id = (res.status === "ok" ? res.data.scheduleId : "") as string;

      const getRes = getSchedule(id, config);
      expect(getRes.status).toBe("ok");
    });

    it("lists all schedules", () => {
      const config = createConfig();
      scheduleTransaction({ op: "a" }, Date.now() + 1000, null, config);
      scheduleTransaction({ op: "b" }, Date.now() + 2000, null, config);

      expect(listSchedules(config)).toHaveLength(2);
      expect(listSchedules(config, "pending")).toHaveLength(2);
      expect(listSchedules(config, "executed")).toHaveLength(0);
    });
  });

  describe("processDueSchedules", () => {
    it("executes due one-time schedules", async () => {
      const config = createConfig();
      const payload = { op: "payment" };
      // Schedule 1 second in the future, then advance time
      const createAt = Date.now();
      scheduleTransaction(payload, createAt + 1000, null, config);

      const dateSpy = vi.spyOn(Date, "now").mockReturnValue(createAt + 2000);

      const execute = vi.fn().mockResolvedValue(undefined);
      const count = await processDueSchedules(config, execute);

      dateSpy.mockRestore();
      expect(count).toBe(1);
      expect(execute).toHaveBeenCalledWith(payload);
    });

    it("reschedules recurring schedules", async () => {
      const config = createConfig();
      const createAt = Date.now();
      scheduleTransaction({ op: "recurring" }, createAt + 1000, 5000, config);

      const dateSpy = vi.spyOn(Date, "now").mockReturnValue(createAt + 2000);

      const execute = vi.fn().mockResolvedValue(undefined);
      await processDueSchedules(config, execute);

      dateSpy.mockRestore();
      const schedules = listSchedules(config, "pending");
      expect(schedules).toHaveLength(1);
      expect(schedules[0].failureCount).toBe(0);
    });

    it("marks schedule as failed after max retries", async () => {
      const config = createConfig({ maxRetries: 2 });
      const createAt = Date.now();
      scheduleTransaction({ op: "fail" }, createAt + 1000, null, config);

      const dateSpy = vi.spyOn(Date, "now").mockReturnValue(createAt + 2000);

      const execute = vi.fn().mockRejectedValue(new Error("boom"));

      await processDueSchedules(config, execute);
      await processDueSchedules(config, execute);

      dateSpy.mockRestore();
      const failed = listSchedules(config, "failed");
      expect(failed).toHaveLength(1);
      expect(failed[0].failureCount).toBe(2);
    });

    it("skips schedules not yet due", async () => {
      const config = createConfig();
      scheduleTransaction(
        { op: "future" },
        Date.now() + 60_000,
        null,
        config,
      );

      const execute = vi.fn();
      const count = await processDueSchedules(config, execute);

      expect(count).toBe(0);
      expect(execute).not.toHaveBeenCalled();
    });
  });
});
