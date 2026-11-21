/**
 * Tests for validateTransactionXdr's size and structural-complexity limits
 * (#838). Kept in a standalone file (not transaction.test.ts, which mocks
 * "@stellar/stellar-sdk" globally) so these tests exercise the real SDK's
 * TransactionBuilder/Account for genuine XDR encode/decode round trips.
 */
import { describe, it, expect } from "vitest";
import {
  Keypair,
  Account,
  TransactionBuilder,
  Operation,
  Asset,
  BASE_FEE,
  Networks,
} from "@stellar/stellar-sdk";
import { validateTransactionXdr } from "../transaction/validateTransactionXdr";

function buildSamplePaymentXdr(opts?: { fee?: string }): string {
  const source = Keypair.random();
  const dest = Keypair.random().publicKey();
  const account = new Account(source.publicKey(), "1");
  const tx = new TransactionBuilder(account, {
    fee: opts?.fee ?? BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({ destination: dest, asset: Asset.native(), amount: "10" }),
    )
    .setTimeout(100)
    .build();
  return tx.toXDR();
}

describe("validateTransactionXdr — size limit (#838)", () => {
  it("accepts a well-formed XDR within the default size limit", () => {
    const xdr = buildSamplePaymentXdr();
    const result = validateTransactionXdr(xdr, { networkPassphrase: Networks.TESTNET });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.valid).toBe(true);
  });

  it("rejects an XDR longer than maxXdrLength without attempting to parse it", () => {
    const oversized = "A".repeat(200_000);
    const result = validateTransactionXdr(oversized, {
      networkPassphrase: Networks.TESTNET,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.valid).toBe(false);
    expect(result.data.errors[0]?.code).toBe("XDR_TOO_LARGE");
    expect(result.data.operationCount).toBe(0);
  });

  it("rejects an XDR longer than a custom maxXdrLength", () => {
    const xdr = buildSamplePaymentXdr();
    const result = validateTransactionXdr(xdr, {
      networkPassphrase: Networks.TESTNET,
      maxXdrLength: 10,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.valid).toBe(false);
    expect(result.data.errors[0]?.code).toBe("XDR_TOO_LARGE");
  });

  it("accepts an XDR exactly at the configured maxXdrLength boundary", () => {
    const xdr = buildSamplePaymentXdr();
    const result = validateTransactionXdr(xdr, {
      networkPassphrase: Networks.TESTNET,
      maxXdrLength: xdr.length,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.valid).toBe(true);
  });

  it("the size check runs before XDR parsing — an oversized malformed string is reported as too-large, not XDR_INVALID", () => {
    const oversizedGarbage = "not-xdr-".repeat(30_000);
    const result = validateTransactionXdr(oversizedGarbage, {
      networkPassphrase: Networks.TESTNET,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.errors[0]?.code).toBe("XDR_TOO_LARGE");
  });
});

describe("validateTransactionXdr — structural complexity limit (#838)", () => {
  function buildMultiOpPaymentXdr(opCount: number): string {
    const source = Keypair.random();
    const account = new Account(source.publicKey(), "1");
    const builder = new TransactionBuilder(account, {
      fee: String(Number(BASE_FEE) * opCount),
      networkPassphrase: Networks.TESTNET,
    });
    for (let i = 0; i < opCount; i++) {
      builder.addOperation(
        Operation.payment({
          destination: Keypair.random().publicKey(),
          asset: Asset.native(),
          amount: "1",
        }),
      );
    }
    return builder.setTimeout(100).build().toXDR();
  }

  it("accepts a transaction within the default operation-count limit", () => {
    const xdr = buildMultiOpPaymentXdr(5);
    const result = validateTransactionXdr(xdr, { networkPassphrase: Networks.TESTNET });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.valid).toBe(true);
    expect(result.data.operationCount).toBe(5);
  });

  it("rejects a transaction exceeding a custom maxOperationCount before running per-operation checks", () => {
    const xdr = buildMultiOpPaymentXdr(10);
    const result = validateTransactionXdr(xdr, {
      networkPassphrase: Networks.TESTNET,
      maxOperationCount: 3,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.valid).toBe(false);
    expect(result.data.errors.some((f) => f.code === "TOO_MANY_OPERATIONS")).toBe(true);
    expect(result.data.operationCount).toBe(10);
  });

  it("accepts a transaction exactly at the configured maxOperationCount boundary", () => {
    const xdr = buildMultiOpPaymentXdr(4);
    const result = validateTransactionXdr(xdr, {
      networkPassphrase: Networks.TESTNET,
      maxOperationCount: 4,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.valid).toBe(true);
  });
});
