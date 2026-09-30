/**
 * E2E framework: multi-signature transaction workflows for 2-of-3 and 3-of-5
 * threshold scenarios, signing over a real transaction envelope end to end
 * (build -> collect signatures -> threshold met) rather than mocked signing.
 */
import { Account, BASE_FEE, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { addSignatureToEnvelope } from "../../wallet";
import { ok } from "../../shared/response";
import type { SorokitResult } from "../../shared/response";
import { runMultiSigWorkflow, twoOfThreeSigners, threeOfFiveSigners, TestDataManager } from "./framework";

const NETWORK = Networks.TESTNET;

function buildUnsignedXdr(sourcePublicKey: string): string {
  const source = new Account(sourcePublicKey, "1");
  return new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: NETWORK })
    .addOperation(Operation.bumpSequence({ bumpTo: "2" }))
    .setTimeout(0)
    .build()
    .toXDR();
}

/** Sign function a real wallet would provide: signs the envelope's hash with the matching test keypair. */
function makeSignFn(keypairsByPublicKey: Map<string, Keypair>) {
  return async (envelopeXdr: string, signerPublicKey: string): Promise<SorokitResult<string>> => {
    const keypair = keypairsByPublicKey.get(signerPublicKey);
    if (!keypair) throw new Error(`no test keypair registered for ${signerPublicKey}`);
    const hash = TransactionBuilder.fromXDR(envelopeXdr, NETWORK).hash();
    const decorated = keypair.signDecorated(hash);
    return ok(addSignatureToEnvelope(envelopeXdr, decorated));
  };
}

describe("E2E framework: multi-sig workflows", () => {
  it("completes a 2-of-3 workflow once two of three signers have signed", async () => {
    const data = new TestDataManager("multisig-2-of-3");
    const fixtures = data.accounts("testnet", "signer", 3);
    const [a, b, c] = [fixtures[0]!, fixtures[1]!, fixtures[2]!];
    const keypairs = new Map(fixtures.map((f) => [f.publicKey, f.keypair]));
    const { signers, threshold } = twoOfThreeSigners([a.publicKey, b.publicKey, c.publicKey]);

    const result = await runMultiSigWorkflow({
      transactionXdr: buildUnsignedXdr(a.publicKey),
      networkPassphrase: NETWORK,
      signers,
      threshold,
      signFn: makeSignFn(keypairs),
    });

    expect(result.ok).toBe(true);
    expect(result.workflow).toBe("multisig:2-of-3");
    // Threshold is met after exactly 2 signatures — the 3rd signer is never asked.
    const signSteps = result.steps.filter((s) => s.step.startsWith("sign:"));
    expect(signSteps).toHaveLength(2);
    expect(result.steps.at(-1)).toMatchObject({ step: "threshold-met", status: "ok" });
  });

  it("completes a 3-of-5 workflow once three of five signers have signed", async () => {
    const data = new TestDataManager("multisig-3-of-5");
    const fixtures = data.accounts("testnet", "signer", 5);
    const keypairs = new Map(fixtures.map((f) => [f.publicKey, f.keypair]));
    const pubkeys = fixtures.map((f) => f.publicKey) as [string, string, string, string, string];
    const { signers, threshold } = threeOfFiveSigners(pubkeys);

    const result = await runMultiSigWorkflow({
      transactionXdr: buildUnsignedXdr(pubkeys[0]),
      networkPassphrase: NETWORK,
      signers,
      threshold,
      signFn: makeSignFn(keypairs),
    });

    expect(result.ok).toBe(true);
    expect(result.workflow).toBe("multisig:3-of-5");
    const signSteps = result.steps.filter((s) => s.step.startsWith("sign:"));
    expect(signSteps).toHaveLength(3);
  });

  it("fails without reaching threshold when fewer signers sign than required", async () => {
    const data = new TestDataManager("multisig-underfunded");
    const fixtures = data.accounts("testnet", "signer", 3);
    const [a, b, c] = [fixtures[0]!, fixtures[1]!, fixtures[2]!];
    const keypairs = new Map(fixtures.map((f) => [f.publicKey, f.keypair]));
    const { signers, threshold } = twoOfThreeSigners([a.publicKey, b.publicKey, c.publicKey]);

    const result = await runMultiSigWorkflow({
      transactionXdr: buildUnsignedXdr(a.publicKey),
      networkPassphrase: NETWORK,
      signers,
      threshold,
      signFn: makeSignFn(keypairs),
      signingOrder: [a.publicKey], // only one of the two required signers signs
    });

    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)).toMatchObject({ step: "threshold-met", status: "error" });
  });

  it("derives the same fixture accounts across independent manager instances with the same seed", () => {
    const first = new TestDataManager("repeatable-seed").account("testnet", "alice");
    const second = new TestDataManager("repeatable-seed").account("testnet", "alice");
    expect(first.publicKey).toBe(second.publicKey);
  });
});
