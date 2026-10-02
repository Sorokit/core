import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { createSorokitClient } from "../client/createSorokitClient";

const secret = process.env.STELLAR_TESTNET_SOURCE_SECRET;
const destination = process.env.STELLAR_TESTNET_DESTINATION;
const enabled = Boolean(secret && destination);

describe.skipIf(!enabled)("testnet integration", () => {
  it("fetches the source account, submits a payment, checks status, and reads the balance", async () => {
    const keypair = Keypair.fromSecret(secret!);
    const clientResult = createSorokitClient({ network: "testnet" });
    expect(clientResult.status).toBe("ok");
    if (clientResult.status !== "ok") return;
    const client = clientResult.data;

    const before = await client.account.get(keypair.publicKey());
    expect(before.status).toBe("ok");

    const unsigned = await client.transaction.buildPayment(keypair.publicKey(), {
      destination: destination!,
      amount: "0.0000001",
      memo: "Sorokit nightly",
    });
    expect(unsigned.status).toBe("ok");
    if (unsigned.status !== "ok") return;

    const transaction = TransactionBuilder.fromXDR(unsigned.data, "Test SDF Network ; September 2015");
    transaction.sign(keypair);
    const signed = transaction.toXDR();
    const submitted = await client.transaction.submit(signed);
    expect(submitted.status).toBe("ok");
    if (submitted.status !== "ok") return;

    const status = await client.transaction.getStatus(submitted.data.hash);
    expect(status.status).toBe("ok");
    if (status.status !== "ok") return;
    expect(status.data.hash).toBe(submitted.data.hash);
    expect(status.data.status).toBe("success");

    const after = await client.account.get(keypair.publicKey());
    expect(after.status).toBe("ok");
  }, 90_000);
});

if (!enabled) {
  console.warn("Skipping testnet integration: set STELLAR_TESTNET_SOURCE_SECRET and STELLAR_TESTNET_DESTINATION.");
}
