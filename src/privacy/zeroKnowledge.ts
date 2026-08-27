export type ProofBytes = Uint8Array | string;

export interface ProofStatement {
  /** Domain-separated statement identifier. */
  type: string;
  /** Public inputs committed to by the proof. */
  publicInputs: Readonly<Record<string, string>>;
}

export interface SelectiveDisclosure {
  /** Claims intentionally disclosed to the verifier. */
  claims: Readonly<Record<string, string>>;
  /** Commitment to the complete private claim set. */
  commitment: string;
}

export interface ZeroKnowledgeProof {
  version: 1;
  system: string;
  proof: ProofBytes;
  statement: ProofStatement;
  disclosure?: SelectiveDisclosure;
}

export interface ProofVerificationContext {
  statement: ProofStatement;
  proof: ProofBytes;
  disclosure?: SelectiveDisclosure;
}

export interface ZeroKnowledgeVerifier {
  verify(context: ProofVerificationContext): Promise<boolean>;
}

export interface PrivateTransactionValidationResult {
  valid: boolean;
  reason?: string;
  statement: ProofStatement;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalClaims(claims: Readonly<Record<string, string>>): string {
  return Object.keys(claims)
    .sort()
    .map((key) => `${key}=${claims[key]}`)
    .join("\n");
}

/** Create a SHA-256 commitment for private claims without exposing their values. */
export async function createClaimCommitment(
  claims: Readonly<Record<string, string>>,
): Promise<string> {
  const input = new TextEncoder().encode(`sorokit:claims:v1\n${canonicalClaims(claims)}`);
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    input as unknown as BufferSource,
  );
  return bytesToHex(new Uint8Array(digest));
}

/** Create a proof envelope for a prover implementation or external proof system. */
export function createProofEnvelope(
  system: string,
  statement: ProofStatement,
  proof: ProofBytes,
  disclosure?: SelectiveDisclosure,
): ZeroKnowledgeProof {
  if (!system.trim()) throw new Error("proof system must not be empty");
  if (!statement.type.trim()) throw new Error("proof statement type must not be empty");
  return disclosure === undefined
    ? { version: 1, system, statement, proof }
    : { version: 1, system, statement, proof, disclosure };
}

/** Verify a proof envelope through a pluggable ZK backend. */
export async function verifyProof(
  envelope: ZeroKnowledgeProof,
  verifier: ZeroKnowledgeVerifier,
): Promise<PrivateTransactionValidationResult> {
  const context: ProofVerificationContext = envelope.disclosure === undefined
    ? { statement: envelope.statement, proof: envelope.proof }
    : { statement: envelope.statement, proof: envelope.proof, disclosure: envelope.disclosure };
  const valid = await verifier.verify(context);
  return valid
    ? { valid: true, statement: envelope.statement }
    : { valid: false, reason: "zero-knowledge proof verification failed", statement: envelope.statement };
}

/**
 * Validate a private transaction while keeping private witness data outside
 * the SDK. The supplied verifier may wrap a Groth16, Plonk, STARK, or remote
 * proving system; Sorokit only standardizes the envelope and verification seam.
 */
export async function validatePrivateTransaction(
  envelope: ZeroKnowledgeProof,
  verifier: ZeroKnowledgeVerifier,
): Promise<PrivateTransactionValidationResult> {
  return verifyProof(envelope, verifier);
}
