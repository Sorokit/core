import { describe, it, expect, vi } from "vitest";
import { createSorokitClient } from "../../client/createSorokitClient";
import { ok } from "../../shared/response";

vi.mock("../../account/getAccount", () => ({
  getAccount: vi.fn(async () =>
    ok({
      publicKey: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
      displayAddress: "GAAZI...CWNA",
      sequence: "1000",
      subentryCount: 0,
      balances: [],
    }),
  ),
}));

vi.mock("../../transaction/buildTransaction", () => ({
  buildPaymentTransaction: vi.fn(async () => ok("mock-payment-xdr")),
  buildCreateAccountTransaction: vi.fn(),
  buildTrustlineTransaction: vi.fn(),
  buildPathPayment: vi.fn(),
}));

vi.mock("../../transaction/submitTransaction", () => ({
  submitTransaction: vi.fn(async () =>
    ok({
      hash: "mock-tx-hash",
      status: "success",
    }),
  ),
}));

describe("Integration: Multi-Step Workflow (Wallet -> Submit)", () => {
  it("executes the full payment workflow seamlessly", async () => {
    const clientResult = createSorokitClient({ network: "testnet" });
    expect(clientResult.status).toBe("ok");
    if (clientResult.status !== "ok") return;
    const client = clientResult.data;

    const adapter = {
      walletType: "FREIGHTER" as const,
      isAvailable: () => true,
      connect: vi.fn().mockResolvedValue(ok("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA")),
      disconnect: vi.fn().mockResolvedValue(ok(undefined)),
      signTransaction: vi.fn().mockResolvedValue(ok("signed-mock-xdr")),
    };

    const connectResult = await client.wallet.connect(adapter);
    expect(connectResult.status).toBe("ok");
    if (connectResult.status !== "ok") return;
    expect(connectResult.data.connected).toBe(true);

    const accountResult = await client.account.get(connectResult.data.publicKey!);
    expect(accountResult.status).toBe("ok");
    if (accountResult.status !== "ok") return;
    expect(accountResult.data.publicKey).toBe(connectResult.data.publicKey);

    const buildResult = await client.transaction.buildPayment(
      connectResult.data.publicKey!,
      {
        destination: "GBBZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
        amount: "10.0",
      },
    );
    expect(buildResult.status).toBe("ok");
    if (buildResult.status !== "ok") return;
    expect(buildResult.data).toBe("mock-payment-xdr");

    const signResult = await client.wallet.signTransaction(adapter, {
      transactionXdr: buildResult.data,
      networkPassphrase: "Test SDF Network ; September 2015",
    });
    expect(signResult.status).toBe("ok");
    if (signResult.status !== "ok") return;
    expect(signResult.data).toBe("signed-mock-xdr");

    const submitResult = await client.transaction.submit(signResult.data);
    expect(submitResult.status).toBe("ok");
    if (submitResult.status !== "ok") return;
    expect(submitResult.data.hash).toBe("mock-tx-hash");
  });
});
