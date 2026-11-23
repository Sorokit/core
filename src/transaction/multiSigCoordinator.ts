import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

export interface SignatureCollectionProgress {
  collectionId: string;
  collected: number;
  /** Number of distinct valid signatures required before finalizing. */
  threshold: number;
  signers: string[];
  complete: boolean;
}

interface Collection {
  xdr: string;
  networkPassphrase: string;
  threshold: number;
  signatures: Map<string, string>;
}

const collections = new Map<string, Collection>();
let counter = 0;

function progress(id: string, c: Collection): SignatureCollectionProgress {
  return {
    collectionId: id,
    collected: c.signatures.size,
    threshold: c.threshold,
    signers: [...c.signatures.keys()],
    complete: c.signatures.size >= c.threshold,
  };
}

/**
 * Start collecting signatures for an unsigned or partially signed transaction.
 * `threshold` is the number of distinct signers required (default 1). Match it
 * to the account's on-chain signer thresholds; the coordinator counts
 * signatures, not signer weights.
 */
export function initializeSignatureCollection(
  transactionXdr: string,
  networkPassphrase: string,
  threshold = 1,
): SorokitResult<string> {
  if (!Number.isInteger(threshold) || threshold < 1) {
    return err(SorokitErrorCode.VALIDATION, "threshold must be a positive integer.");
  }
  try {
    TransactionBuilder.fromXDR(transactionXdr, networkPassphrase);
  } catch (cause) {
    return err(SorokitErrorCode.XDR_INVALID, "Transaction XDR could not be parsed.", cause);
  }
  const id = `sigcol_${Date.now().toString(36)}_${(counter++).toString(36)}`;
  collections.set(id, { xdr: transactionXdr, networkPassphrase, threshold, signatures: new Map() });
  return ok(id);
}

/** Add one signer's base64 signature over the transaction hash. Duplicates are ignored. */
export function addSignature(
  collectionId: string,
  signerPublicKey: string,
  signature: string,
): SorokitResult<SignatureCollectionProgress> {
  const c = collections.get(collectionId);
  if (!c) return err(SorokitErrorCode.VALIDATION, `Unknown signature collection: ${collectionId}`);
  try {
    const tx = TransactionBuilder.fromXDR(c.xdr, c.networkPassphrase);
    const valid = Keypair.fromPublicKey(signerPublicKey).verify(tx.hash(), Buffer.from(signature, "base64"));
    if (!valid) return err(SorokitErrorCode.INVALID_AUTH, "Signature does not match signer and transaction.");
  } catch (cause) {
    return err(SorokitErrorCode.INVALID_AUTH, "Signature could not be verified.", cause);
  }
  c.signatures.set(signerPublicKey, signature);
  return ok(progress(collectionId, c));
}

/** Merge the collected signatures into the transaction and return signed XDR. */
export function finalizeTransaction(collectionId: string): SorokitResult<string> {
  const c = collections.get(collectionId);
  if (!c) return err(SorokitErrorCode.VALIDATION, `Unknown signature collection: ${collectionId}`);
  if (c.signatures.size < c.threshold) {
    return err(
      SorokitErrorCode.INVALID_AUTH,
      `Threshold not met: ${c.signatures.size} of ${c.threshold} signatures collected.`,
    );
  }
  try {
    const tx = TransactionBuilder.fromXDR(c.xdr, c.networkPassphrase);
    for (const [key, sig] of c.signatures) tx.addSignature(key, sig);
    collections.delete(collectionId);
    return ok(tx.toXDR());
  } catch (cause) {
    return err(SorokitErrorCode.TX_BUILD_FAILED, "Failed to merge signatures.", cause);
  }
}
