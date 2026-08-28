import {
  Account,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  createMultiSigContractExecution,
  MultiSigContractExecution,
} from "../soroban/multiSigExecution";
import type { ContractSigningRequest } from "../soroban/multiSigExecution";

const NETWORK = Networks.TESTNET;

// Deterministic signers so failures are reproducible.
const SIGNER_A = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
const SIGNER_B = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2));
const SIGNER_C = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3));
const OUTSIDER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9));

/** Build an unsigned transaction to stand in for a prepared contract invocation. */
function buildUnsignedXdr(): string {
  const source = new Account(SIGNER_A.publicKey(), "1");
  return new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: NETWORK })
    .addOperation(Operation.bumpSequence({ bumpTo: "2" }))
    .setTimeout(0)
    .build()
    .toXDR();
}

const UNSIGNED_XDR = buildUnsignedXdr();

/** Sign a request's canonical payload the way a wallet would. */
function sign(request: ContractSigningRequest, keypair: Keypair): string {
  return keypair.sign(Buffer.from(request.payloadHash, "hex")).toString("base64");
}

function workflow(): MultiSigContractExecution {
  return createMultiSigContractExecution();
}

function newRequest(
  execution: MultiSigContractExecution,
  overrides: Partial<Parameters<MultiSigContractExecution["createSigningRequest"]>[0]> = {},
): ContractSigningRequest {
  const result = execution.createSigningRequest({
    transactionXdr: UNSIGNED_XDR,
    networkPassphrase: NETWORK,
    signers: [
      { publicKey: SIGNER_A.publicKey() },
      { publicKey: SIGNER_B.publicKey() },
      { publicKey: SIGNER_C.publicKey() },
    ],
    threshold: 2,
    ...overrides,
  });
  if (result.status === "error") throw new Error(result.error.message);
  return result.data;
}

describe("createSigningRequest", () => {
  it("creates a request carrying a canonical payload derived from the transaction", () => {
    const request = newRequest(workflow());
    const expected = TransactionBuilder.fromXDR(UNSIGNED_XDR, NETWORK).hash().toString("hex");

    expect(request.payloadHash).toBe(expected);
    expect(request.status).toBe("collecting");
    expect(request.collectedWeight).toBe(0);
  });

  it("supports N-of-M configuration with explicit weights", () => {
    const request = newRequest(workflow(), {
      signers: [
        { publicKey: SIGNER_A.publicKey(), weight: 2 },
        { publicKey: SIGNER_B.publicKey(), weight: 1 },
      ],
      threshold: 3,
    });

    expect(request.signers).toEqual([
      { publicKey: SIGNER_A.publicKey(), weight: 2 },
      { publicKey: SIGNER_B.publicKey(), weight: 1 },
    ]);
    expect(request.threshold).toBe(3);
  });

  it("defaults an omitted signer weight to 1", () => {
    expect(newRequest(workflow()).signers.every((s) => s.weight === 1)).toBe(true);
  });

  it("rejects an empty signer list", () => {
    const result = workflow().createSigningRequest({
      transactionXdr: UNSIGNED_XDR,
      networkPassphrase: NETWORK,
      signers: [],
      threshold: 1,
    });

    expect(result.status).toBe("error");
    expect(result.error?.message).toContain("at least one signer");
  });

  it("rejects a duplicate signer in the configuration", () => {
    const result = workflow().createSigningRequest({
      transactionXdr: UNSIGNED_XDR,
      networkPassphrase: NETWORK,
      signers: [{ publicKey: SIGNER_A.publicKey() }, { publicKey: SIGNER_A.publicKey() }],
      threshold: 1,
    });

    expect(result.status).toBe("error");
    expect(result.error?.message).toContain("listed more than once");
  });

  it("rejects an unreachable threshold", () => {
    const result = workflow().createSigningRequest({
      transactionXdr: UNSIGNED_XDR,
      networkPassphrase: NETWORK,
      signers: [{ publicKey: SIGNER_A.publicKey() }],
      threshold: 5,
    });

    expect(result.status).toBe("error");
    expect(result.error?.message).toContain("can never be met");
  });

  it("rejects a threshold below 1", () => {
    const result = workflow().createSigningRequest({
      transactionXdr: UNSIGNED_XDR,
      networkPassphrase: NETWORK,
      signers: [{ publicKey: SIGNER_A.publicKey() }],
      threshold: 0,
    });

    expect(result.status).toBe("error");
  });

  it("rejects a non-positive signer weight", () => {
    const result = workflow().createSigningRequest({
      transactionXdr: UNSIGNED_XDR,
      networkPassphrase: NETWORK,
      signers: [{ publicKey: SIGNER_A.publicKey(), weight: 0 }],
      threshold: 1,
    });

    expect(result.status).toBe("error");
    expect(result.error?.message).toContain("invalid weight");
  });

  it("rejects a malformed signer public key", () => {
    const result = workflow().createSigningRequest({
      transactionXdr: UNSIGNED_XDR,
      networkPassphrase: NETWORK,
      signers: [{ publicKey: "not-a-key" }],
      threshold: 1,
    });

    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("INVALID_ADDRESS");
  });

  it("rejects malformed transaction XDR", () => {
    const result = workflow().createSigningRequest({
      transactionXdr: "garbage",
      networkPassphrase: NETWORK,
      signers: [{ publicKey: SIGNER_A.publicKey() }],
      threshold: 1,
    });

    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("TX_BUILD_FAILED");
  });

  it("rejects an expiry that is already in the past", () => {
    const result = workflow().createSigningRequest({
      transactionXdr: UNSIGNED_XDR,
      networkPassphrase: NETWORK,
      signers: [{ publicKey: SIGNER_A.publicKey() }],
      threshold: 1,
      now: 1_000,
      expiresAt: 500,
    });

    expect(result.status).toBe("error");
    expect(result.error?.message).toContain("must be in the future");
  });

  it("binds the payload to the network passphrase", () => {
    const testnet = newRequest(workflow());
    const futurenet = workflow().createSigningRequest({
      transactionXdr: UNSIGNED_XDR,
      networkPassphrase: Networks.FUTURENET,
      signers: [{ publicKey: SIGNER_A.publicKey() }],
      threshold: 1,
    });

    expect(futurenet.data?.payloadHash).not.toBe(testnet.payloadHash);
  });
});

describe("addSignature", () => {
  it("accepts a valid signature and credits its weight", () => {
    const execution = workflow();
    const request = newRequest(execution);
    const result = execution.addSignature(request.id, SIGNER_A.publicKey(), sign(request, SIGNER_A));

    expect(result.status).toBe("ok");
    expect(result.data?.collectedWeight).toBe(1);
    expect(result.data?.signatures).toHaveLength(1);
  });

  it("rejects a signature that does not verify and credits no weight", () => {
    const execution = workflow();
    const request = newRequest(execution);

    // A real signature, but produced by a different key than the one claimed.
    const forged = sign(request, OUTSIDER);
    const result = execution.addSignature(request.id, SIGNER_A.publicKey(), forged);

    expect(result.status).toBe("error");
    expect(result.error?.message).toContain("not a valid signature");
    expect(execution.getRequestState(request.id).data?.collectedWeight).toBe(0);
  });

  it("rejects a signature over a different payload", () => {
    const execution = workflow();
    const request = newRequest(execution);
    const wrongPayload = SIGNER_A.sign(Buffer.from("some other payload")).toString("base64");

    expect(execution.addSignature(request.id, SIGNER_A.publicKey(), wrongPayload).status).toBe(
      "error",
    );
  });

  it("rejects structurally invalid signature bytes", () => {
    const execution = workflow();
    const request = newRequest(execution);

    expect(execution.addSignature(request.id, SIGNER_A.publicKey(), "!!!not-base64!!!").status).toBe(
      "error",
    );
  });

  it("rejects a signer that is not declared on the request", () => {
    const execution = workflow();
    const request = newRequest(execution);
    const result = execution.addSignature(
      request.id,
      OUTSIDER.publicKey(),
      sign(request, OUTSIDER),
    );

    expect(result.status).toBe("error");
    expect(result.error?.message).toContain("not a declared signer");
  });

  it("rejects a duplicate submission from the same signer", () => {
    const execution = workflow();
    const request = newRequest(execution);
    execution.addSignature(request.id, SIGNER_A.publicKey(), sign(request, SIGNER_A));
    const duplicate = execution.addSignature(
      request.id,
      SIGNER_A.publicKey(),
      sign(request, SIGNER_A),
    );

    expect(duplicate.status).toBe("error");
    expect(duplicate.error?.message).toContain("already signed");
    expect(execution.getRequestState(request.id).data?.collectedWeight).toBe(1);
  });

  it("does not let one signer alone satisfy a two-signer threshold", () => {
    const execution = workflow();
    const request = newRequest(execution);
    execution.addSignature(request.id, SIGNER_A.publicKey(), sign(request, SIGNER_A));
    execution.addSignature(request.id, SIGNER_A.publicKey(), sign(request, SIGNER_A));

    expect(execution.getRequestState(request.id).data?.thresholdMet).toBe(false);
    expect(execution.execute(request.id).status).toBe("error");
  });

  it("marks the request ready once the threshold is met", () => {
    const execution = workflow();
    const request = newRequest(execution);
    execution.addSignature(request.id, SIGNER_A.publicKey(), sign(request, SIGNER_A));
    const second = execution.addSignature(request.id, SIGNER_B.publicKey(), sign(request, SIGNER_B));

    expect(second.data?.status).toBe("ready");
    expect(second.data?.collectedWeight).toBe(2);
  });

  it("reaches the threshold on weight, not signer count", () => {
    const execution = workflow();
    const request = newRequest(execution, {
      signers: [
        { publicKey: SIGNER_A.publicKey(), weight: 3 },
        { publicKey: SIGNER_B.publicKey(), weight: 1 },
      ],
      threshold: 3,
    });
    const result = execution.addSignature(request.id, SIGNER_A.publicKey(), sign(request, SIGNER_A));

    expect(result.data?.status).toBe("ready");
  });

  it("rejects a signature on an unknown request", () => {
    expect(workflow().addSignature("missing", SIGNER_A.publicKey(), "sig").status).toBe("error");
  });

  it("refuses signatures once the request has expired", () => {
    const execution = workflow();
    const request = newRequest(execution, { now: 0, expiresAt: 1_000 });
    const result = execution.addSignature(
      request.id,
      SIGNER_A.publicKey(),
      sign(request, SIGNER_A),
      1_001,
    );

    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("OPERATION_TIMEOUT");
  });
});

describe("getRequestState", () => {
  it("reports collection progress and who is still pending", () => {
    const execution = workflow();
    const request = newRequest(execution);
    execution.addSignature(request.id, SIGNER_A.publicKey(), sign(request, SIGNER_A));

    expect(execution.getRequestState(request.id).data).toMatchObject({
      status: "collecting",
      collectedWeight: 1,
      threshold: 2,
      remainingWeight: 1,
      thresholdMet: false,
      signedBy: [SIGNER_A.publicKey()],
      pendingSigners: [SIGNER_B.publicKey(), SIGNER_C.publicKey()],
    });
  });

  it("clamps remaining weight at zero once satisfied", () => {
    const execution = workflow();
    const request = newRequest(execution, {
      signers: [{ publicKey: SIGNER_A.publicKey(), weight: 5 }],
      threshold: 2,
    });
    execution.addSignature(request.id, SIGNER_A.publicKey(), sign(request, SIGNER_A));

    expect(execution.getRequestState(request.id).data?.remainingWeight).toBe(0);
  });

  it("transitions to expired once the deadline passes", () => {
    const execution = workflow();
    const request = newRequest(execution, { now: 0, expiresAt: 1_000 });

    expect(execution.getRequestState(request.id, 999).data?.status).toBe("collecting");
    expect(execution.getRequestState(request.id, 1_000).data?.status).toBe("expired");
  });

  it("reports an unknown request as an error", () => {
    expect(workflow().getRequestState("missing").status).toBe("error");
  });
});

describe("execute", () => {
  it("blocks execution while the threshold is unmet", () => {
    const execution = workflow();
    const request = newRequest(execution);
    execution.addSignature(request.id, SIGNER_A.publicKey(), sign(request, SIGNER_A));

    const result = execution.execute(request.id);
    expect(result.status).toBe("error");
    expect(result.error?.message).toContain("threshold not met");
  });

  it("blocks execution with no signatures at all", () => {
    const execution = workflow();
    expect(execution.execute(newRequest(execution).id).status).toBe("error");
  });

  it("assembles a signed envelope carrying every collected signature", () => {
    const execution = workflow();
    const request = newRequest(execution);
    execution.addSignature(request.id, SIGNER_A.publicKey(), sign(request, SIGNER_A));
    execution.addSignature(request.id, SIGNER_B.publicKey(), sign(request, SIGNER_B));

    const result = execution.execute(request.id);
    expect(result.status).toBe("ok");

    const signed = TransactionBuilder.fromXDR(result.data!, NETWORK);
    expect(signed.signatures).toHaveLength(2);
  });

  it("produces signatures that verify against the signers", () => {
    const execution = workflow();
    const request = newRequest(execution);
    execution.addSignature(request.id, SIGNER_A.publicKey(), sign(request, SIGNER_A));
    execution.addSignature(request.id, SIGNER_B.publicKey(), sign(request, SIGNER_B));

    const signed = TransactionBuilder.fromXDR(execution.execute(request.id).data!, NETWORK);
    const payload = signed.hash();

    for (const keypair of [SIGNER_A, SIGNER_B]) {
      const match = signed.signatures.find((s) =>
        s.hint().equals(keypair.signatureHint()),
      );
      expect(match).toBeDefined();
      expect(keypair.verify(payload, match!.signature())).toBe(true);
    }
  });

  it("marks the request executed and refuses a second execution", () => {
    const execution = workflow();
    const request = newRequest(execution);
    execution.addSignature(request.id, SIGNER_A.publicKey(), sign(request, SIGNER_A));
    execution.addSignature(request.id, SIGNER_B.publicKey(), sign(request, SIGNER_B));
    execution.execute(request.id);

    expect(execution.getRequestState(request.id).data?.status).toBe("executed");
    const again = execution.execute(request.id);
    expect(again.status).toBe("error");
    expect(again.error?.message).toContain("already been executed");
  });

  it("refuses further signatures after execution", () => {
    const execution = workflow();
    const request = newRequest(execution);
    execution.addSignature(request.id, SIGNER_A.publicKey(), sign(request, SIGNER_A));
    execution.addSignature(request.id, SIGNER_B.publicKey(), sign(request, SIGNER_B));
    execution.execute(request.id);

    const late = execution.addSignature(request.id, SIGNER_C.publicKey(), sign(request, SIGNER_C));
    expect(late.status).toBe("error");
    expect(late.error?.message).toContain("already been executed");
  });

  it("refuses to execute an expired request even when the threshold was met", () => {
    const execution = workflow();
    const request = newRequest(execution, { now: 0, expiresAt: 1_000 });
    execution.addSignature(request.id, SIGNER_A.publicKey(), sign(request, SIGNER_A), 10);
    execution.addSignature(request.id, SIGNER_B.publicKey(), sign(request, SIGNER_B), 20);

    expect(execution.getRequestState(request.id, 20).data?.thresholdMet).toBe(true);

    const result = execution.execute(request.id, 1_001);
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("OPERATION_TIMEOUT");
  });

  it("executes normally before the deadline", () => {
    const execution = workflow();
    const request = newRequest(execution, { now: 0, expiresAt: 1_000 });
    execution.addSignature(request.id, SIGNER_A.publicKey(), sign(request, SIGNER_A), 10);
    execution.addSignature(request.id, SIGNER_B.publicKey(), sign(request, SIGNER_B), 20);

    expect(execution.execute(request.id, 999).status).toBe("ok");
  });

  it("reports an unknown request", () => {
    expect(workflow().execute("missing").status).toBe("error");
  });
});

describe("request lifecycle", () => {
  it("lists and cancels tracked requests", () => {
    const execution = workflow();
    const request = newRequest(execution);

    expect(execution.listRequests()).toHaveLength(1);
    expect(execution.cancelRequest(request.id)).toBe(true);
    expect(execution.cancelRequest(request.id)).toBe(false);
    expect(execution.getRequest(request.id)).toBeUndefined();
  });

  it("keeps concurrent requests independent", () => {
    const execution = workflow();
    const first = newRequest(execution);
    const second = newRequest(execution);

    expect(first.id).not.toBe(second.id);
    execution.addSignature(first.id, SIGNER_A.publicKey(), sign(first, SIGNER_A));

    expect(execution.getRequestState(first.id).data?.collectedWeight).toBe(1);
    expect(execution.getRequestState(second.id).data?.collectedWeight).toBe(0);
  });

  it("clears all tracked requests", () => {
    const execution = workflow();
    newRequest(execution);
    execution.clear();

    expect(execution.listRequests()).toEqual([]);
  });
});
