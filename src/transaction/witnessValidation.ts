import { TransactionBuilder, Keypair } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

export interface SignatureValidationResult {
  valid: boolean;
  signerKey: string;
  validSignature: boolean;
  issues: string[];
}

export interface WitnessValidationResult {
  valid: boolean;
  signatureResults: SignatureValidationResult[];
  missingSigners: string[];
  duplicateSigners: string[];
  thresholdMet: boolean;
  issues: string[];
}

export function verifyTransactionSignatures(
  transactionXdr: string,
  networkPassphrase: string,
  requiredSigners?: string[],
  threshold?: number,
): SorokitResult<WitnessValidationResult> {
  let transaction;
  try {
    transaction = TransactionBuilder.fromXDR(transactionXdr, networkPassphrase);
  } catch (cause) {
    return err(SorokitErrorCode.TX_BUILD_FAILED, `Failed to parse transaction XDR: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  const envelope = (transaction as any)._envelope || (transaction as any).tx;
  const signatures = envelope?.signatures() || [];
  const signatureResults: SignatureValidationResult[] = [];
  const seenSigners = new Set<string>();
  const duplicateSigners: string[] = [];

  for (const sig of signatures) {
    const hint = sig.hint();
    const signature = sig.signature();

    let signerKey = "";
    try {
      signerKey = Buffer.from(hint).toString("hex").toUpperCase();
    } catch {
      signatureResults.push({
        valid: false,
        signerKey: "unknown",
        validSignature: false,
        issues: ["Could not decode signature hint"],
      });
      continue;
    }

    const sigBase64 = Buffer.from(signature).toString("base64");

    let validSignature = false;
    try {
      const valid = Keypair.fromPublicKey(signerKey).verify(transaction.hash(), signature);
      validSignature = valid;
    } catch {
      validSignature = false;
    }

    if (seenSigners.has(signerKey)) {
      duplicateSigners.push(signerKey);
    }
    seenSigners.add(signerKey);

    const issues: string[] = [];
    if (!validSignature) issues.push("Signature verification failed");

    signatureResults.push({
      valid: validSignature,
      signerKey,
      validSignature,
      issues,
    });
  }

  const issues: string[] = [];
  let missingSigners: string[] = [];

  if (requiredSigners && requiredSigners.length > 0) {
    missingSigners = requiredSigners.filter((s) => !seenSigners.has(s));
    if (missingSigners.length > 0) {
      issues.push(`Missing required signers: ${missingSigners.join(", ")}`);
    }
  }

  if (duplicateSigners.length > 0) {
    issues.push(`Duplicate signatures detected: ${duplicateSigners.join(", ")}`);
  }

  const totalValidWeight = signatureResults.filter((r) => r.validSignature).length;
  const thresholdMet = threshold ? totalValidWeight >= threshold : signatureResults.length > 0;

  return ok({
    valid: issues.length === 0,
    signatureResults,
    missingSigners,
    duplicateSigners,
    thresholdMet,
    issues,
  });
}
