import { describe, expect, it } from "vitest";
import { Account, Asset, Keypair, Networks, Operation, Transaction, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { createEnvelopeBuilder, EnvelopeBuilder, MAX_ENVELOPE_SIGNATURES } from "./envelopeBuilder";
import { SorokitErrorCode } from "../shared/response";

const source = Keypair.random();
const alice = Keypair.random();
const bob = Keypair.random();
const carol = Keypair.random();

function unsignedTx(): Transaction {
  return new TransactionBuilder(new Account(source.publicKey(), "100"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.payment({ destination: alice.publicKey(), asset: Asset.native(), amount: "1" }))
    .setTimeout(0)
    .build();
}

function builderFor(xdrString = unsignedTx().toXDR(), opts = {}): EnvelopeBuilder {
  const r = createEnvelopeBuilder(xdrString, Networks.TESTNET, opts);
  if (r.status !== "ok") throw new Error(r.error.message);
  return r.data;
}

describe("createEnvelopeBuilder", () => {
  it("rejects malformed XDR and a missing passphrase", () => {
    const bad = createEnvelopeBuilder("not-xdr", Networks.TESTNET);
    expect(bad.status === "error" && bad.error.code).toBe(SorokitErrorCode.XDR_INVALID);
    const noPass = createEnvelopeBuilder(unsignedTx().toXDR(), "");
    expect(noPass.status === "error" && noPass.error.code).toBe(SorokitErrorCode.VALIDATION);
  });

  it("imports existing signatures it can attribute", () => {
    const tx = unsignedTx();
    tx.sign(alice, bob);
    const b = builderFor(tx.toXDR(), { knownSigners: [bob.publicKey(), alice.publicKey()] });
    expect(b.getSigners()).toEqual([alice.publicKey(), bob.publicKey()]);
  });

  it("refuses unattributable existing signatures unless told to drop them", () => {
    const tx = unsignedTx();
    tx.sign(alice, carol);
    const strict = createEnvelopeBuilder(tx.toXDR(), Networks.TESTNET, { knownSigners: [alice.publicKey()] });
    expect(strict.status === "error" && strict.error.message).toContain("matches none of knownSigners");

    const lenient = builderFor(tx.toXDR(), { knownSigners: [alice.publicKey()], dropUnattributedSignatures: true });
    expect(lenient.getSigners()).toEqual([alice.publicKey()]);
  });
});

describe("EnvelopeBuilder signatures", () => {
  it("adds verified signatures from raw bytes or base64", () => {
    const b = builderFor();
    const raw = b.addSignature({ publicKey: alice.publicKey(), signature: alice.sign(b.getHashBytes()) });
    const b64 = b.addSignature({ publicKey: bob.publicKey(), signature: bob.sign(b.getHashBytes()).toString("base64") });
    expect(raw.status).toBe("ok");
    expect(b64.status).toBe("ok");
    expect(b.getSignatures()).toEqual([
      expect.objectContaining({ publicKey: alice.publicKey(), hint: alice.signatureHint().toString("base64") }),
      expect.objectContaining({ publicKey: bob.publicKey() }),
    ]);
  });

  it("rejects signatures that do not verify for this transaction", () => {
    const b = builderFor();
    // Right signer, but signed over some other 32-byte hash.
    const wrongTx = alice.sign(Buffer.alloc(32, 1));
    const r = b.addSignature({ publicKey: alice.publicKey(), signature: wrongTx });
    expect(r.status === "error" && r.error.message).toContain("does not verify");

    const wrongSigner = b.addSignature({ publicKey: bob.publicKey(), signature: alice.sign(b.getHashBytes()) });
    expect(wrongSigner.status).toBe("error");
    expect(b.getSignatures()).toHaveLength(0);
  });

  it("rejects a signature made for another network", () => {
    const tx = unsignedTx();
    const publicNet = TransactionBuilder.fromXDR(tx.toXDR(), Networks.PUBLIC);
    const b = builderFor(tx.toXDR());
    const r = b.addSignature({ publicKey: alice.publicKey(), signature: alice.sign(publicNet.hash()) });
    expect(r.status).toBe("error");
  });

  it("validates key and signature shape", () => {
    const b = builderFor();
    expect(b.addSignature({ publicKey: "GBAD", signature: new Uint8Array(64) }).status).toBe("error");
    const short = b.addSignature({ publicKey: alice.publicKey(), signature: new Uint8Array(10) });
    expect(short.status === "error" && short.error.message).toContain("must be 64 bytes");
    expect(b.addSignature({ publicKey: alice.publicKey(), signature: "!!not base64!!" }).status).toBe("error");
  });

  it("replaces a re-added signer in place and removes signers", () => {
    const b = builderFor();
    b.sign(alice);
    b.sign(bob);
    b.sign(alice);
    expect(b.getSigners()).toEqual([alice.publicKey(), bob.publicKey()]);

    expect(b.removeSignature(alice.publicKey())).toBe(true);
    expect(b.removeSignature(alice.publicKey())).toBe(false);
    expect(b.hasSignature(alice.publicKey())).toBe(false);
    expect(b.getSigners()).toEqual([bob.publicKey()]);
  });

  it("enforces the 20-signature protocol limit", () => {
    const b = builderFor();
    const signers = Array.from({ length: MAX_ENVELOPE_SIGNATURES }, () => Keypair.random());
    signers.forEach((k) => expect(b.sign(k).status).toBe("ok"));
    const extra = b.sign(Keypair.random());
    expect(extra.status === "error" && extra.error.message).toContain("at most 20");
    // replacing an existing signer is still allowed at the limit
    expect(b.sign(signers[0] as Keypair).status).toBe("ok");
  });

  it("getSignatures returns copies", () => {
    const b = builderFor();
    b.sign(alice);
    (b.getSignatures()[0] as { publicKey: string }).publicKey = "tampered";
    expect(b.getSigners()).toEqual([alice.publicKey()]);
  });
});

describe("EnvelopeBuilder.build", () => {
  it("serializes a submittable envelope whose signatures verify", () => {
    const b = builderFor();
    b.sign(alice);
    b.sign(bob);
    const r = b.build();
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;

    expect(r.data.envelopeType).toBe("transaction");
    expect(r.data.networkPassphrase).toBe(Networks.TESTNET);
    const parsed = TransactionBuilder.fromXDR(r.data.envelopeXdr, Networks.TESTNET);
    expect(parsed.hash().toString("hex")).toBe(r.data.hash);
    expect(parsed.signatures).toHaveLength(2);
    expect(alice.verify(parsed.hash(), parsed.signatures[0]!.signature())).toBe(true);
    expect(bob.verify(parsed.hash(), parsed.signatures[1]!.signature())).toBe(true);
    expect(xdr.TransactionEnvelope.fromXDR(r.data.envelopeXdr, "base64").switch().name).toBe("envelopeTypeTx");
  });

  it("reflects removals and does not mutate the builder", () => {
    const b = builderFor();
    b.sign(alice);
    const first = b.build();
    b.removeSignature(alice.publicKey());
    const second = b.build();
    expect(first.status === "ok" && first.data.signatures).toHaveLength(1);
    expect(second.status === "ok" && TransactionBuilder.fromXDR(second.data.envelopeXdr, Networks.TESTNET).signatures).toHaveLength(0);
    expect(first.status === "ok" && second.status === "ok" && first.data.hash === second.data.hash).toBe(true);
  });

  it("supports fee-bump envelopes", () => {
    const inner = unsignedTx();
    inner.sign(source);
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(carol, "200", inner, Networks.TESTNET);
    const b = builderFor(feeBump.toXDR());
    b.sign(carol);
    const r = b.build();
    expect(r.status === "ok" && r.data.envelopeType).toBe("feeBump");
    if (r.status !== "ok") return;
    const parsed = TransactionBuilder.fromXDR(r.data.envelopeXdr, Networks.TESTNET);
    expect(parsed.signatures).toHaveLength(1);
    expect(carol.verify(parsed.hash(), parsed.signatures[0]!.signature())).toBe(true);
  });
});
