/**
 * Tests for buildFeeBumpTransaction (#398).
 */

import { describe, it, expect } from "vitest";
import {
  Account,
  Asset,
  FeeBumpTransaction,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { buildFeeBumpTransaction } from "../transaction/feeBumpTransaction";

const PASSPHRASE = Networks.TESTNET;

function buildSignedInnerTx(): { xdr: string; source: Keypair } {
  const source = Keypair.random();
  const destination = Keypair.random().publicKey();
  const account = new Account(source.publicKey(), "0");
  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(
      Operation.payment({
        destination,
        asset: Asset.native(),
        amount: "10",
      }),
    )
    .setTimeout(30)
    .build();
  tx.sign(source);
  return { xdr: tx.toXDR(), source };
}

describe("buildFeeBumpTransaction (#398)", () => {
  const feeAccount = Keypair.random().publicKey();

  it("builds a fee-bump transaction from a valid inner transaction", () => {
    const { xdr } = buildSignedInnerTx();

    const result = buildFeeBumpTransaction(xdr, feeAccount, "200", PASSPHRASE);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const parsed = TransactionBuilder.fromXDR(result.data, PASSPHRASE);
    expect(parsed).toBeInstanceOf(FeeBumpTransaction);
    const feeBump = parsed as FeeBumpTransaction;
    expect(feeBump.feeSource).toBe(feeAccount);
  });

  it("preserves the inner transaction semantics byte-for-byte", () => {
    const { xdr } = buildSignedInnerTx();

    const result = buildFeeBumpTransaction(xdr, feeAccount, 200, PASSPHRASE);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const feeBump = TransactionBuilder.fromXDR(
      result.data,
      PASSPHRASE,
    ) as FeeBumpTransaction;
    expect(feeBump.innerTransaction.toXDR()).toBe(xdr);
  });

  it("accepts a numeric base fee", () => {
    const { xdr } = buildSignedInnerTx();
    const result = buildFeeBumpTransaction(xdr, feeAccount, 500, PASSPHRASE);
    expect(result.status).toBe("ok");
  });

  it("rejects malformed inner XDR", () => {
    const result = buildFeeBumpTransaction(
      "not-valid-xdr",
      feeAccount,
      "200",
      PASSPHRASE,
    );
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("TX_BUILD_FAILED");
  });

  it("rejects an empty inner XDR", () => {
    const result = buildFeeBumpTransaction("", feeAccount, "200", PASSPHRASE);
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("TX_BUILD_FAILED");
  });

  it("rejects an invalid fee account", () => {
    const { xdr } = buildSignedInnerTx();
    const result = buildFeeBumpTransaction(
      xdr,
      "not-an-address",
      "200",
      PASSPHRASE,
    );
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("INVALID_ADDRESS");
  });

  it("rejects a non-integer base fee", () => {
    const { xdr } = buildSignedInnerTx();
    const result = buildFeeBumpTransaction(
      xdr,
      feeAccount,
      "12.5",
      PASSPHRASE,
    );
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("TX_BUILD_FAILED");
  });

  it("rejects a base fee below the network minimum", () => {
    const { xdr } = buildSignedInnerTx();
    const result = buildFeeBumpTransaction(xdr, feeAccount, "50", PASSPHRASE);
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("TX_BUILD_FAILED");
    expect(result.error?.message).toContain("network minimum");
  });

  it("rejects a base fee below the inner transaction's base fee", () => {
    const source = Keypair.random();
    const account = new Account(source.publicKey(), "0");
    const tx = new TransactionBuilder(account, {
      fee: "1000",
      networkPassphrase: PASSPHRASE,
    })
      .addOperation(
        Operation.payment({
          destination: Keypair.random().publicKey(),
          asset: Asset.native(),
          amount: "1",
        }),
      )
      .setTimeout(30)
      .build();
    tx.sign(source);

    const result = buildFeeBumpTransaction(
      tx.toXDR(),
      feeAccount,
      "100",
      PASSPHRASE,
    );
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("TX_BUILD_FAILED");
    expect(result.error?.message).toContain("must be higher than the inner transaction fee");
  });

  it("rejects a base fee equal to the inner transaction's base fee (downgrade prevention)", () => {
    const source = Keypair.random();
    const account = new Account(source.publicKey(), "0");
    const tx = new TransactionBuilder(account, {
      fee: "200",
      networkPassphrase: PASSPHRASE,
    })
      .addOperation(
        Operation.payment({
          destination: Keypair.random().publicKey(),
          asset: Asset.native(),
          amount: "1",
        }),
      )
      .setTimeout(30)
      .build();
    tx.sign(source);

    const result = buildFeeBumpTransaction(
      tx.toXDR(),
      feeAccount,
      "200",
      PASSPHRASE,
    );
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("TX_BUILD_FAILED");
    expect(result.error?.message).toContain("must be higher than the inner transaction fee");
  });

  it("rejects wrapping an existing fee-bump transaction", () => {
    const { xdr } = buildSignedInnerTx();
    const first = buildFeeBumpTransaction(xdr, feeAccount, "200", PASSPHRASE);
    expect(first.status).toBe("ok");
    if (first.status !== "ok") return;

    const second = buildFeeBumpTransaction(
      first.data,
      feeAccount,
      "400",
      PASSPHRASE,
    );
    expect(second.status).toBe("error");
    expect(second.error?.message).toContain("already a fee-bump");
  });

  it("rejects an empty network passphrase", () => {
    const { xdr } = buildSignedInnerTx();
    const result = buildFeeBumpTransaction(xdr, feeAccount, "200", "");
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("INVALID_NETWORK");
  });
});
