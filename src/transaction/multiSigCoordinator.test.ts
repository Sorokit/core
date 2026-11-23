import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { addSignature, finalizeTransaction, initializeSignatureCollection } from "./multiSigCoordinator";

function makeTx(source: Keypair) {
  return new TransactionBuilder(new Account(source.publicKey(), "1"), { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.payment({ destination: Keypair.random().publicKey(), asset: Asset.native(), amount: "1" }))
    .setTimeout(0)
    .build();
}

describe("multiSigCoordinator", () => {
  it("collects signatures up to the threshold and finalizes", () => {
    const [a, b] = [Keypair.random(), Keypair.random()];
    const tx = makeTx(a);
    const id = initializeSignatureCollection(tx.toXDR(), Networks.TESTNET, 2);
    if (id.status !== "ok") throw new Error("init failed");
    const sig = (k: Keypair) => k.sign(tx.hash()).toString("base64");

    expect(finalizeTransaction(id.data).status).toBe("error");
    const p1 = addSignature(id.data, a.publicKey(), sig(a));
    expect(p1.status === "ok" && p1.data.complete).toBe(false);
    addSignature(id.data, a.publicKey(), sig(a));
    const p2 = addSignature(id.data, b.publicKey(), sig(b));
    expect(p2.status === "ok" && p2.data.collected).toBe(2);

    const done = finalizeTransaction(id.data);
    expect(done.status).toBe("ok");
    if (done.status === "ok") {
      expect(TransactionBuilder.fromXDR(done.data, Networks.TESTNET).signatures).toHaveLength(2);
    }
  });

  it("rejects bad signatures, bad XDR, and unknown collections", () => {
    const k = Keypair.random();
    const tx = makeTx(k);
    expect(initializeSignatureCollection("nope", Networks.TESTNET).status).toBe("error");
    expect(initializeSignatureCollection(tx.toXDR(), Networks.TESTNET, 0).status).toBe("error");
    const id = initializeSignatureCollection(tx.toXDR(), Networks.TESTNET);
    if (id.status !== "ok") throw new Error("init failed");
    const wrong = Keypair.random().sign(tx.hash()).toString("base64");
    expect(addSignature(id.data, k.publicKey(), wrong).status).toBe("error");
    expect(addSignature("missing", k.publicKey(), wrong).status).toBe("error");
  });
});
