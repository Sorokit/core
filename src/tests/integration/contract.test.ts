import { describe, it, expect, vi } from "vitest";
import { createSorokitClient } from "../../client/createSorokitClient";
import { ok } from "../../shared/response";

vi.mock("../../soroban/prepareCall", () => ({
  prepareContractCall: vi.fn(async () =>
    ok({
      transactionXdr: "mock-prepared-xdr",
      fee: "100",
    }),
  ),
}));

vi.mock("../../soroban/executeContract", () => ({
  executeContract: vi.fn(async () => ok("mock-tx-hash")),
}));

describe("Integration: Contract Workflow", () => {
  it("prepares, signs, and executes a contract invocation", async () => {
    const clientResult = createSorokitClient({ network: "testnet" });
    expect(clientResult.status).toBe("ok");
    if (clientResult.status !== "ok") return;
    const client = clientResult.data;

    const prepareResult = await client.soroban.prepare({
      publicKey: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
      contractId: "CAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
      method: "increment",
      args: [],
    });
    expect(prepareResult.status).toBe("ok");
    if (prepareResult.status !== "ok") return;
    expect(prepareResult.data.transactionXdr).toBe("mock-prepared-xdr");

    const signResult = await client.wallet.signTransaction(
      {
        walletType: "FREIGHTER" as const,
        isAvailable: () => true,
        connect: vi.fn(),
        disconnect: vi.fn(),
        signTransaction: vi.fn(async () => ok("signed-contract-xdr")),
      },
      {
        transactionXdr: prepareResult.data.transactionXdr,
        networkPassphrase: "Test SDF Network ; September 2015",
      },
    );
    expect(signResult.status).toBe("ok");
    if (signResult.status !== "ok") return;
    expect(signResult.data).toBe("signed-contract-xdr");

    const executeResult = await client.soroban.execute(signResult.data);
    expect(executeResult.status).toBe("ok");
    if (executeResult.status !== "ok") return;
    expect(executeResult.data).toBe("mock-tx-hash");
  });
});
