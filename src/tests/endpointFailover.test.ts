import { describe, expect, it, vi } from "vitest";
import {
  createFailoverFetch,
  EndpointPool,
} from "../network/endpointFailover";
import { mapHorizonError } from "../shared/horizonErrorMapper";
import { SorokitErrorCode } from "../shared/response";

function withFakeNow(startMs: number) {
  const spy = vi.spyOn(Date, "now").mockReturnValue(startMs);
  return {
    advanceTo: (ms: number) => spy.mockReturnValue(ms),
    restore: () => spy.mockRestore(),
  };
}

describe("endpoint failover", () => {
  it("retries a transient primary failure on the backup", async () => {
    const pool = new EndpointPool([
      "https://primary.example",
      "https://backup.example",
    ], { failureThreshold: 1 });
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const response = await createFailoverFetch(pool, fetcher)("https://primary.example/ledgers");

    expect(response.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1]?.[0])).toContain("backup.example");
    expect(pool.getHealth()[0]?.healthy).toBe(false);
  });

  it("skips an endpoint that exceeded its failure threshold and prefers the healthy one (#855)", () => {
    const pool = new EndpointPool(
      ["https://primary.example", "https://backup.example"],
      { failureThreshold: 2, recoveryIntervalMs: 60_000 },
    );

    pool.markFailure("https://primary.example");
    pool.markFailure("https://primary.example");

    const primaryHealth = pool
      .getHealth()
      .find((h) => h.endpoint === "https://primary.example");
    expect(primaryHealth?.healthy).toBe(false);
    expect(primaryHealth?.consecutiveFailures).toBe(2);

    // With the primary unhealthy and inside its recovery window, `current`
    // must select the still-healthy backup rather than cycling back to it.
    expect(pool.current).toBe("https://backup.example");
    expect(pool.current).toBe("https://backup.example");
  });

  it("recovers an unhealthy endpoint once its recovery window elapses (#855)", () => {
    const clock = withFakeNow(1_000_000);
    try {
      const pool = new EndpointPool(
        ["https://primary.example", "https://backup.example"],
        { failureThreshold: 1, recoveryIntervalMs: 30_000 },
      );

      pool.markFailure("https://primary.example");
      expect(
        pool.getHealth().find((h) => h.endpoint === "https://primary.example")
          ?.healthy,
      ).toBe(false);

      // Still inside the recovery window: the primary stays deprioritised.
      clock.advanceTo(1_000_000 + 10_000);
      expect(pool.current).toBe("https://backup.example");

      // Recovery window has elapsed: the primary is eligible to be selected
      // again even though its `healthy` flag hasn't been reset yet (recovery
      // is a time-based retry opportunity, confirmed by a real request's
      // markSuccess call, not an automatic flip).
      clock.advanceTo(1_000_000 + 30_000);
      const candidates = new Set<string>();
      for (let i = 0; i < pool.endpoints.length; i += 1) candidates.add(pool.current);
      expect(candidates.has("https://primary.example")).toBe(true);

      pool.markSuccess("https://primary.example");
      expect(
        pool.getHealth().find((h) => h.endpoint === "https://primary.example")
          ?.healthy,
      ).toBe(true);
    } finally {
      clock.restore();
    }
  });

  it("maps common Horizon response classes to stable SDK codes", () => {
    expect(mapHorizonError({ status: 400, message: "tx_bad_auth" }).code)
      .toBe(SorokitErrorCode.INVALID_TRANSACTION);
    expect(mapHorizonError({ status: 404 }, { resource: "account" }).code)
      .toBe(SorokitErrorCode.ACCOUNT_NOT_FOUND);
    expect(mapHorizonError({ status: 500 }).code)
      .toBe(SorokitErrorCode.SERVICE_UNAVAILABLE);
  });
});
