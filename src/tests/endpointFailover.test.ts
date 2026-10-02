import { describe, expect, it, vi } from "vitest";
import {
  createFailoverFetch,
  EndpointPool,
} from "../network/endpointFailover";
import { mapHorizonError } from "../shared/horizonErrorMapper";
import { SorokitErrorCode } from "../shared/response";

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

  it("maps common Horizon response classes to stable SDK codes", () => {
    expect(mapHorizonError({ status: 400, message: "tx_bad_auth" }).code)
      .toBe(SorokitErrorCode.INVALID_TRANSACTION);
    expect(mapHorizonError({ status: 404 }, { resource: "account" }).code)
      .toBe(SorokitErrorCode.ACCOUNT_NOT_FOUND);
    expect(mapHorizonError({ status: 500 }).code)
      .toBe(SorokitErrorCode.SERVICE_UNAVAILABLE);
  });
});
