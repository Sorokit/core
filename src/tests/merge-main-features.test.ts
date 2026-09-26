import { afterEach, describe, expect, it, vi } from "vitest";
import { createCustomEndpoint, applyHeadersToFetch } from "../network/customEndpoints";
import { StructuredLogger } from "../shared/structuredLogging";
import {
  analyzeBatchCost,
  compareCosts,
  forecastTransactionCost,
  suggestOptimization,
} from "../transaction/costForecasting";
import {
  generateRollbackInstructions,
  getTransactionStatus,
  submitBatch,
  suggestRetryStrategy,
  wasAtomicExecuted,
  type BatchSubmissionResult,
} from "../transaction/batchSubmitter";
import { discoverAvailableWallets } from "../wallet/discovery";
import {
  clearWalletSession,
  loadWalletSession,
  saveWalletSession,
} from "../wallet/sessionPersistence";

describe("merged main feature helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, "window");
  });

  it("validates custom endpoints and applies configured headers", () => {
    const endpoint = createCustomEndpoint({
      url: "https://horizon.example.com/path",
      headers: { Authorization: "Bearer token" },
    });

    expect(endpoint.status).toBe("ok");
    if (endpoint.status !== "ok") return;

    const init = applyHeadersToFetch(endpoint.data, {
      headers: { Accept: "application/json" },
    });
    const headers = init.headers as Headers;

    expect(headers.get("authorization")).toBe("Bearer token");
    expect(headers.get("accept")).toBe("application/json");
    expect(createCustomEndpoint({ url: "not a url" }).status).toBe("error");
  });

  it("forecasts, compares, and analyzes transaction operation costs", () => {
    const payment = forecastTransactionCost("payment");
    const comparison = compareCosts(["payment", "createAccount", "invokeHostFunction"]);
    const suggestions = suggestOptimization("payment");
    const batch = analyzeBatchCost(["payment", "createAccount"]);

    expect(payment.status).toBe("ok");
    expect(comparison.status).toBe("ok");
    expect(suggestions.status).toBe("ok");
    expect(batch.status).toBe("ok");

    if (comparison.status === "ok") {
      expect(comparison.data.cheapest).toBe("payment");
      expect(comparison.data.mostExpensive).toBe("invokeHostFunction");
    }
    expect(forecastTransactionCost("").status).toBe("error");
    expect(analyzeBatchCost([]).status).toBe("error");
  });

  it("tracks batch transaction status and retry guidance", () => {
    const submitted = submitBatch(["tx-one", "tx-two"], {
      atomic: true,
      rollbackOnFailure: true,
    });

    expect(submitted.status).toBe("ok");
    if (submitted.status !== "ok") return;

    expect(submitted.data.rollbackOnFailure).toBe(true);
    expect(getTransactionStatus(submitted.data, 1).status).toBe("ok");
    expect(getTransactionStatus(submitted.data, 5).status).toBe("error");

    const failedBatch: BatchSubmissionResult = {
      ...submitted.data,
      status: "partial_success",
      transactions: [
        { xdr: "tx-one", status: "success" },
        { xdr: "tx-two", status: "failed", error: "bad sequence" },
      ],
    };

    const rollback = generateRollbackInstructions(failedBatch);
    const retry = suggestRetryStrategy(failedBatch);
    const atomicComplete = wasAtomicExecuted(failedBatch);

    expect(rollback.status).toBe("ok");
    expect(retry.status).toBe("ok");
    expect(atomicComplete.status).toBe("ok");
    if (retry.status === "ok") expect(retry.data.failedIndices).toEqual([1]);
    if (atomicComplete.status === "ok") expect(atomicComplete.data).toBe(false);
  });

  it("discovers browser wallets and persists wallet session state", async () => {
    const storage = new Map<string, string>();
    Reflect.set(globalThis, "window", {
      freighter: {},
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    });

    const wallets = await discoverAvailableWallets();
    expect(wallets.status).toBe("ok");
    if (wallets.status === "ok") {
      expect(wallets.data[0]?.id).toBe("freighter");
      expect(wallets.data[0]?.installed).toBe(true);
    }

    const state = {
      accountId: "GABC",
      connectedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      network: "testnet",
    };

    expect(saveWalletSession(state).status).toBe("ok");
    const loaded = loadWalletSession();
    expect(loaded.status).toBe("ok");
    if (loaded.status === "ok") expect(loaded.data).toEqual(state);
    expect(clearWalletSession().status).toBe("ok");
    const cleared = loadWalletSession();
    if (cleared.status === "ok") expect(cleared.data).toBeNull();
  });

  it("emits redacted structured logs through a custom logger", () => {
    const records: unknown[] = [];
    const logger = new StructuredLogger({
      enabled: true,
      level: "INFO",
      redactSensitive: true,
      logger: (_level, _message, meta) => records.push(meta),
    });

    logger.debug("hidden", { token: "secret" });
    logger.info("visible", { token: "secret", nested: { apiKey: "key" } });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      operation: "visible",
      token: "[REDACTED]",
      nested: { apiKey: "[REDACTED]" },
    });
  });
});
