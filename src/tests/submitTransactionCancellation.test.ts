import {
  Account,
  Asset,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { submitTransaction } from "../transaction/submitTransaction";

function signedXdr(sequence: string): string {
  const keypair = Keypair.random();
  const account = new Account(keypair.publicKey(), sequence);
  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: keypair.publicKey(),
        asset: Asset.native(),
        amount: "1",
      }),
    )
    .setTimeout(30)
    .build();
  tx.sign(keypair);
  return tx.toXDR();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("submitTransaction cancellation", () => {
  it("sends no submit attempt when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const spy = vi.spyOn(Horizon.Server.prototype, "submitTransaction");

    const result = await submitTransaction(
      "https://horizon.invalid",
      Networks.TESTNET,
      signedXdr("1"),
      undefined,
      { signal: controller.signal },
    );

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.error.message).toMatch(/cancelled|aborted/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not retry a submit attempt after the signal is aborted mid-flight", async () => {
    const controller = new AbortController();
    let attempts = 0;
    vi.spyOn(Horizon.Server.prototype, "submitTransaction").mockImplementation(async () => {
      attempts += 1;
      controller.abort();
      throw Object.assign(new Error("Horizon request failed (HTTP 503)"), {
        response: { status: 503 },
      });
    });

    const result = await submitTransaction(
      "https://horizon.invalid",
      Networks.TESTNET,
      signedXdr("2"),
      undefined,
      { signal: controller.signal },
    );

    expect(result.status).toBe("error");
    expect(attempts).toBe(1);
  });
});
