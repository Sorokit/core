import { describe, it, expect } from "vitest";
import {
  Account,
  Asset,
  FeeBumpTransaction,
  Keypair,
  Memo,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { sponsorTransaction, sponsorOperation } from "./sponsorshipBuilder";
import { SorokitErrorCode } from "../shared/response";

const SOURCE = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const SPONSOR_A = Keypair.random().publicKey();
const SPONSOR_B = Keypair.random().publicKey();
const USDC = new Asset("USDC", Keypair.random().publicKey());

function buildTx(
  operations: ReturnType<typeof Operation.payment>[],
  opts: { memo?: Memo; fee?: string; timeout?: number } = {},
): Transaction {
  const builder = new TransactionBuilder(new Account(SOURCE, "100"), {
    fee: opts.fee ?? "100",
    networkPassphrase: Networks.TESTNET,
    ...(opts.memo ? { memo: opts.memo } : {}),
  });
  for (const op of operations) builder.addOperation(op);
  return builder.setTimeout(opts.timeout ?? 300).build();
}

const payment = () => Operation.payment({ destination: DEST, asset: Asset.native(), amount: "1" });
const trust = () => Operation.changeTrust({ asset: USDC });

describe("sponsorTransaction", () => {
  it("wraps the operations in a begin/end sponsorship pair", () => {
    const res = sponsorTransaction(buildTx([trust()]), SPONSOR_A);
    expect(res.status).toBe("ok");
    const ops = res.data!.operations;

    expect(ops.map((o) => o.type)).toEqual([
      "beginSponsoringFutureReserves",
      "changeTrust",
      "endSponsoringFutureReserves",
    ]);
    const begin = ops[0] as Operation.BeginSponsoringFutureReserves;
    expect(begin.sponsoredId).toBe(SOURCE);
    // The sponsor authorises `begin`; the sponsored account authorises `end`.
    expect(begin.source).toBe(SPONSOR_A);
    expect(ops[2]!.source).toBe(SOURCE);
  });

  it("sets the sponsor for each of several different sponsors", () => {
    for (const sponsor of [SPONSOR_A, SPONSOR_B]) {
      const res = sponsorTransaction(buildTx([trust()]), sponsor);
      expect(res.status).toBe("ok");
      expect(res.data!.operations[0]!.source).toBe(sponsor);
    }
  });

  it("handles several operations and various operation kinds", () => {
    const tx = buildTx([
      payment(),
      trust(),
      Operation.manageData({ name: "k", value: "v" }),
    ]);
    const res = sponsorTransaction(tx, SPONSOR_A);

    expect(res.status).toBe("ok");
    expect(res.data!.operations.map((o) => o.type)).toEqual([
      "beginSponsoringFutureReserves",
      "payment",
      "changeTrust",
      "manageData",
      "endSponsoringFutureReserves",
    ]);
  });

  it("preserves source, sequence, memo, network and timebounds", () => {
    const tx = buildTx([payment()], { memo: Memo.text("hello"), timeout: 600 });
    const res = sponsorTransaction(tx, SPONSOR_A);
    const out = res.data!;

    expect(out.source).toBe(tx.source);
    expect(out.sequence).toBe(tx.sequence);
    expect(out.networkPassphrase).toBe(Networks.TESTNET);
    expect(out.memo.value?.toString()).toBe("hello");
    expect(out.timeBounds).toEqual(tx.timeBounds);
  });

  it("keeps the per-operation fee, so the total covers the added operations", () => {
    const tx = buildTx([payment(), payment()], { fee: "200" });
    const out = sponsorTransaction(tx, SPONSOR_A).data!;
    // Two original operations at 200 each; four after wrapping, still 200 each.
    expect(Number(tx.fee)).toBe(200 * 2);
    expect(Number(out.fee)).toBe(200 * 4);
    expect(Number(out.fee) / out.operations.length).toBe(200);
  });

  it("returns an unsigned transaction", () => {
    const tx = buildTx([payment()]);
    tx.sign(Keypair.random());
    expect(tx.signatures).toHaveLength(1);
    expect(sponsorTransaction(tx, SPONSOR_A).data!.signatures).toHaveLength(0);
  });

  it("produces XDR that round-trips", () => {
    const out = sponsorTransaction(buildTx([payment()]), SPONSOR_A).data!;
    const parsed = TransactionBuilder.fromXDR(out.toXDR(), Networks.TESTNET) as Transaction;
    expect(parsed.operations).toHaveLength(3);
  });

  it("rejects an invalid sponsor address", () => {
    for (const bad of ["", "not-a-key", "SABC"]) {
      const res = sponsorTransaction(buildTx([payment()]), bad);
      expect(res.status).toBe("error");
      expect(res.error?.code).toBe(SorokitErrorCode.INVALID_ADDRESS);
    }
  });

  it("rejects a sponsor equal to the transaction source", () => {
    const res = sponsorTransaction(buildTx([payment()]), SOURCE);
    expect(res.error?.code).toBe(SorokitErrorCode.INVALID_ADDRESS);
  });

  it("rejects fee-bump transactions", () => {
    const inner = buildTx([payment()]);
    inner.sign(Keypair.random());
    const bump = TransactionBuilder.buildFeeBumpTransaction(
      Keypair.random(),
      "200",
      inner,
      Networks.TESTNET,
    );
    expect(bump).toBeInstanceOf(FeeBumpTransaction);
    const res = sponsorTransaction(bump as unknown as Transaction, SPONSOR_A);
    expect(res.error?.code).toBe(SorokitErrorCode.INVALID_TRANSACTION);
  });

  it("rejects transactions containing Soroban operations", () => {
    const tx = buildTx([Operation.restoreFootprint({}) as never]);
    const res = sponsorTransaction(tx, SPONSOR_A);
    expect(res.error?.code).toBe(SorokitErrorCode.INVALID_TRANSACTION);
  });
});

describe("sponsorOperation", () => {
  it("returns begin, the operation and end, in order", () => {
    const op = Operation.changeTrust({ asset: USDC, source: SOURCE });
    const res = sponsorOperation(op, SPONSOR_A);

    expect(res.status).toBe("ok");
    expect(res.data).toHaveLength(3);
    expect(res.data![1]).toBe(op);
  });

  it("derives the sponsored account from the operation source", () => {
    const op = Operation.changeTrust({ asset: USDC, source: SOURCE });
    const [begin, , end] = sponsorOperation(op, SPONSOR_A).data!;

    const decoded = Operation.fromXDRObject(begin!) as Operation.BeginSponsoringFutureReserves;
    expect(decoded.sponsoredId).toBe(SOURCE);
    expect(decoded.source).toBe(SPONSOR_A);
    expect(Operation.fromXDRObject(end!).source).toBe(SOURCE);
  });

  it("uses an explicit sponsored account when the operation has no source", () => {
    const op = Operation.changeTrust({ asset: USDC });
    const res = sponsorOperation(op, SPONSOR_B, SOURCE);

    expect(res.status).toBe("ok");
    const begin = Operation.fromXDRObject(res.data![0]!) as Operation.BeginSponsoringFutureReserves;
    expect(begin.sponsoredId).toBe(SOURCE);
    expect(begin.source).toBe(SPONSOR_B);
  });

  it("works for different operation kinds", () => {
    const ops = [
      Operation.createAccount({ destination: DEST, startingBalance: "2", source: SOURCE }),
      Operation.manageData({ name: "k", value: "v", source: SOURCE }),
      Operation.manageSellOffer({
        selling: Asset.native(),
        buying: USDC,
        amount: "1",
        price: "1",
        source: SOURCE,
      }),
    ];
    for (const op of ops) {
      const res = sponsorOperation(op, SPONSOR_A);
      expect(res.status).toBe("ok");
      expect(res.data).toHaveLength(3);
    }
  });

  it("can be added to a transaction and sponsors it end to end", () => {
    const op = Operation.changeTrust({ asset: USDC, source: SOURCE });
    const builder = new TransactionBuilder(new Account(SOURCE, "5"), {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    });
    for (const o of sponsorOperation(op, SPONSOR_A).data!) builder.addOperation(o);
    const tx = builder.setTimeout(30).build();

    expect(tx.operations.map((o) => o.type)).toEqual([
      "beginSponsoringFutureReserves",
      "changeTrust",
      "endSponsoringFutureReserves",
    ]);
  });

  it("errors when the sponsored account cannot be determined", () => {
    const res = sponsorOperation(Operation.changeTrust({ asset: USDC }), SPONSOR_A);
    expect(res.error?.code).toBe(SorokitErrorCode.INVALID_ADDRESS);
  });

  it("rejects an invalid sponsor or sponsored address", () => {
    const op = Operation.changeTrust({ asset: USDC, source: SOURCE });
    expect(sponsorOperation(op, "bad").error?.code).toBe(SorokitErrorCode.INVALID_ADDRESS);
    expect(sponsorOperation(op, SPONSOR_A, "bad").error?.code).toBe(
      SorokitErrorCode.INVALID_ADDRESS,
    );
  });

  it("rejects a sponsor equal to the sponsored account", () => {
    const op = Operation.changeTrust({ asset: USDC, source: SOURCE });
    expect(sponsorOperation(op, SOURCE).error?.code).toBe(SorokitErrorCode.INVALID_ADDRESS);
  });

  it("rejects Soroban operations", () => {
    const op = Operation.restoreFootprint({ source: SOURCE });
    expect(sponsorOperation(op, SPONSOR_A).error?.code).toBe(SorokitErrorCode.INVALID_TRANSACTION);
  });
});
