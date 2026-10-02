/**
 * Multi-signature transaction workflow runner.
 *
 * Drives buildMultiSigEnvelope + collectSignature across an arbitrary set of
 * signers and reports per-signature outcomes, so M-of-N scenarios (2-of-3,
 * 3-of-5, ...) can be exercised and asserted on end to end.
 */

import { buildMultiSigEnvelope, collectSignature } from "../../../transaction/multiSig";
import type { MultiSigSigner } from "../../../transaction/types";
import type { SorokitResult } from "../../../shared/response";
import type { WorkflowResult, WorkflowStepResult } from "./types";

export type SignEnvelopeFn = (envelopeXdr: string, signerPublicKey: string) => Promise<SorokitResult<string>>;

export interface MultiSigWorkflowOptions {
  transactionXdr: string;
  networkPassphrase: string;
  signers: MultiSigSigner[];
  threshold: number;
  signFn: SignEnvelopeFn;
  /**
   * Order in which signatures are collected. Defaults to `signers` order.
   * Pass a subset to verify a workflow reaches `thresholdMet` before every
   * signer has signed.
   */
  signingOrder?: string[];
}

export async function runMultiSigWorkflow(options: MultiSigWorkflowOptions): Promise<WorkflowResult> {
  const steps: WorkflowStepResult[] = [];
  const workflow = `multisig:${options.threshold}-of-${options.signers.length}`;

  const buildStarted = Date.now();
  const buildResult = buildMultiSigEnvelope(options.transactionXdr, options.networkPassphrase, {
    signers: options.signers,
    threshold: options.threshold,
  });
  steps.push({
    step: "build-envelope",
    status: buildResult.status === "ok" ? "ok" : "error",
    durationMs: Date.now() - buildStarted,
    ...(buildResult.status === "error" ? { detail: buildResult.error.message } : {}),
  });
  if (buildResult.status === "error") {
    return { workflow, ok: false, steps };
  }

  let envelope = buildResult.data;
  const order = options.signingOrder ?? options.signers.map((s) => s.publicKey);

  for (const signerKey of order) {
    const started = Date.now();
    const result = await collectSignature(envelope, signerKey, options.signFn);
    steps.push({
      step: `sign:${signerKey}`,
      status: result.status === "ok" ? "ok" : "error",
      durationMs: Date.now() - started,
      ...(result.status === "error" ? { detail: result.error.message } : {}),
    });
    if (result.status === "error") {
      return { workflow, ok: false, steps };
    }
    envelope = result.data;
    if (envelope.thresholdMet) break;
  }

  steps.push({
    step: "threshold-met",
    status: envelope.thresholdMet ? "ok" : "error",
    durationMs: 0,
    detail: `collected ${envelope.collectedWeight}/${envelope.threshold}`,
  });

  return { workflow, ok: envelope.thresholdMet, steps };
}

/** Build an equal-weight `signers` + `threshold` pair for a 2-of-3 scenario. */
export function twoOfThreeSigners(publicKeys: readonly [string, string, string]): {
  signers: MultiSigSigner[];
  threshold: number;
} {
  return { signers: publicKeys.map((publicKey) => ({ publicKey, weight: 1 })), threshold: 2 };
}

/** Build an equal-weight `signers` + `threshold` pair for a 3-of-5 scenario. */
export function threeOfFiveSigners(
  publicKeys: readonly [string, string, string, string, string],
): { signers: MultiSigSigner[]; threshold: number } {
  return { signers: publicKeys.map((publicKey) => ({ publicKey, weight: 1 })), threshold: 3 };
}
