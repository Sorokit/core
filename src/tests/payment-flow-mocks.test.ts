import { describe, expect, it } from "vitest";
import { clearSubmittedDirectPaymentTransactions, sendDirectPayment } from "../integration/sep31DirectPayment";
import { initiateInteractiveDeposit, validateInteractiveCallback } from "../integration/sep24Flow";
import { createMockClient } from "../testing/mockClient";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SimulateTransactionResult } from "../soroban/types";

const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("SEP-31 transaction idempotency", () => {
  it("rejects a duplicate transaction ID unless explicitly allowed", async () => {
    clearSubmittedDirectPaymentTransactions();
    const fetcher = async () => response({ id: "tx-1" });
    const first = await sendDirectPayment("https://anchor.test", "10", "GABC", { fetch: fetcher, transactionId: "tx-1" });
    const duplicate = await sendDirectPayment("https://anchor.test", "10", "GABC", { fetch: fetcher, transactionId: "tx-1" });
    expect(first.status).toBe("ok");
    expect(duplicate).toMatchObject({ status: "error", error: { code: SorokitErrorCode.VALIDATION } });
  });
});

describe("SEP-24 callback state", () => {
  it("binds the redirect and consumes state once", async () => {
    const fetcher = async () => response({ url: "https://anchor.test/interactive" });
    const initiated = await initiateInteractiveDeposit("https://anchor.test", { code: "USDC" }, { fetch: fetcher, state: "state-1" });
    expect(initiated.status).toBe("ok");
    if (initiated.status !== "ok") return;
    expect(initiated.data.url).toContain("state=state-1");
    expect(validateInteractiveCallback("https://anchor.test", String(initiated.data.url)).status).toBe("ok");
    expect(validateInteractiveCallback("https://anchor.test", String(initiated.data.url)).status).toBe("error");
  });
});

describe("mock Soroban controls", () => {
  it("stubs invoke and simulation results", async () => {
    const client = createMockClient();
    const invokeResult = ok("stubbed-hash");
    const simulationResult = err<SimulateTransactionResult>(SorokitErrorCode.CONTRACT_SIMULATE_FAILED, "stubbed failure");
    client.stubContractInvoke("C1", "pay", invokeResult);
    client.stubSimulateTransaction(simulationResult);
    expect(await client.soroban.invoke({ contractId: "C1", method: "pay", publicKey: "GABC" }, async (xdr) => xdr)).toEqual(invokeResult);
    expect(await client.soroban.simulate("XDR")).toEqual(simulationResult);
  });
});
