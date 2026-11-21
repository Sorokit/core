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

export interface ZeroKnowledgeVerificationLimits {
  /** Maximum encoded proof length, in bytes. */
  maxProofSizeBytes: number;
  /** Maximum combined number of public inputs and disclosed claims. */
  maxCircuitComplexity: number;
}

export const DEFAULT_ZERO_KNOWLEDGE_VERIFICATION_LIMITS: Readonly<ZeroKnowledgeVerificationLimits> = {
  maxProofSizeBytes: 1024 * 1024,
  maxCircuitComplexity: 1_000,
};

export interface PrivateTransactionValidationResult {
  valid: boolean;
  reason?: string;
  statement: ProofStatement;
}

let verificationLimits: ZeroKnowledgeVerificationLimits = {
  ...DEFAULT_ZERO_KNOWLEDGE_VERIFICATION_LIMITS,
};

/** Configure process-wide proof verification limits. */
export function configureZeroKnowledgeVerificationLimits(
  limits: Partial<ZeroKnowledgeVerificationLimits>,
): void {
  const nextLimits = { ...verificationLimits, ...limits };
  for (const [name, value] of Object.entries(nextLimits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${name} must be a non-negative safe integer`);
    }
  }
  verificationLimits = nextLimits;
}

function proofSizeBytes(proof: ProofBytes): number {
  if (typeof proof !== "string") return proof.byteLength;

  let size = 0;
  for (let index = 0; index < proof.length; index += 1) {
    const codeUnit = proof.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      size += 1;
    } else if (codeUnit <= 0x7ff) {
      size += 2;
    } else if (
      codeUnit >= 0xd800 &&
      codeUnit <= 0xdbff &&
      index + 1 < proof.length &&
      proof.charCodeAt(index + 1) >= 0xdc00 &&
      proof.charCodeAt(index + 1) <= 0xdfff
    ) {
      size += 4;
      index += 1;
    } else {
      size += 3;
    }
  }
  return size;
}

function assertProofWithinLimits(envelope: ZeroKnowledgeProof): void {
  const sizeBytes = proofSizeBytes(envelope.proof);
  if (sizeBytes > verificationLimits.maxProofSizeBytes) {
    throw new RangeError(
      `Zero-knowledge proof size ${sizeBytes} bytes exceeds the configured limit of ${verificationLimits.maxProofSizeBytes} bytes`,
    );
  }

  const complexityLimit = verificationLimits.maxCircuitComplexity;
  let complexity = 0;
  const countInputs = (inputs: Readonly<Record<string, string>>): void => {
    for (const key in inputs) {
      if (Object.prototype.hasOwnProperty.call(inputs, key)) {
        complexity += 1;
        if (complexity > complexityLimit) {
          throw new RangeError(
            `Zero-knowledge proof circuit complexity exceeds the configured limit of ${complexityLimit} (actual complexity is at least ${complexity})`,
          );
        }
      }
    }
  };

  countInputs(envelope.statement.publicInputs);
  if (envelope.disclosure !== undefined) countInputs(envelope.disclosure.claims);
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
  assertProofWithinLimits(envelope);
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
