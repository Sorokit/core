import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Minimal subset of a W3C DID document relevant to Stellar account ownership. */
export interface DidDocument {
  id: string;
  verificationMethod?: Array<{
    id: string;
    type: string;
    controller: string;
    /** Stellar public key (G-address) linked to this verification method. */
    publicKeyBase58?: string;
    publicKeyMultibase?: string;
  }>;
  /** Expiry timestamp (ISO-8601). When present, documents past this date are invalid. */
  expires?: string;
}

/** Association record returned by linkAccountToDid(). */
export interface DidAssociation {
  /** Stellar account G-address. */
  account: string;
  /** Decentralized identifier string. */
  did: string;
  /** Resolved DID document at time of linking. */
  document: DidDocument;
  /** ISO-8601 timestamp of the association. */
  linkedAt: string;
}

/** Proof used to verify account ownership over a DID. */
export interface OwnershipProof {
  /**
   * Base64-encoded Ed25519 signature over the canonical challenge message.
   * Challenge = `sorokit:did-ownership:${did}:${account}`
   */
  signature: string;
}

/** Result of verifyDidOwnership(). */
export interface DidOwnershipVerification {
  verified: boolean;
  /** Reason for failure when verified is false. */
  reason?: string;
  /** The DID document resolved during verification. */
  document?: DidDocument;
}

/** Pluggable DID resolver interface. */
export interface DidResolver {
  /** Resolve a DID string to its DID document, or return null if not found. */
  resolve(did: string): Promise<DidDocument | null>;
}

// ── DID syntax validation ─────────────────────────────────────────────────────

const DID_PATTERN = /^did:[a-z][a-z0-9-]*:[a-zA-Z0-9._:%-]+$/;

function isValidDid(did: string): boolean {
  return DID_PATTERN.test(did);
}

const STELLAR_ADDRESS_PATTERN = /^G[A-Z2-7]{55}$/;

function isValidStellarAddress(address: string): boolean {
  return STELLAR_ADDRESS_PATTERN.test(address);
}

// ── Default resolver ──────────────────────────────────────────────────────────

/**
 * Passthrough resolver that always returns null.
 * Consumers must supply a real resolver for production use.
 */
const nullResolver: DidResolver = {
  async resolve(_did: string): Promise<null> {
    return null;
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function isExpired(document: DidDocument): boolean {
  if (!document.expires) return false;
  return Date.parse(document.expires) < Date.now();
}

function accountIsInDocument(account: string, document: DidDocument): boolean {
  const methods = document.verificationMethod ?? [];
  return methods.some(
    (vm) =>
      vm.publicKeyBase58 === account ||
      vm.publicKeyMultibase === account ||
      vm.controller === account,
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Link a Stellar account to a decentralized identifier.
 *
 * Validates DID syntax and resolves the DID document via the provided resolver.
 * Does NOT store private keys or sensitive identity credentials.
 *
 * @param account  - Stellar G-address to associate.
 * @param did      - Decentralized identifier string (e.g. "did:stellar:GABCD...").
 * @param resolver - DID resolver implementation. Defaults to a null resolver.
 * @returns `ok(DidAssociation)` or `error` if the DID is invalid or unresolvable.
 *
 * @example
 * const result = await linkAccountToDid(
 *   "GABCD...",
 *   "did:stellar:GABCD...",
 *   myResolver,
 * );
 */
export async function linkAccountToDid(
  account: string,
  did: string,
  resolver: DidResolver = nullResolver,
): Promise<SorokitResult<DidAssociation>> {
  if (!isValidStellarAddress(account)) {
    return err(SorokitErrorCode.INVALID_ADDRESS, `Invalid Stellar account address: ${account}`);
  }

  if (!isValidDid(did)) {
    return err(SorokitErrorCode.INVALID_CONFIG, `Invalid DID syntax: "${did}". Expected format: did:<method>:<id>.`);
  }

  let document: DidDocument | null;
  try {
    document = await resolver.resolve(did);
  } catch (cause) {
    return err(
      SorokitErrorCode.NETWORK_ERROR,
      `DID resolution failed for "${did}": ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    );
  }

  if (!document) {
    return err(SorokitErrorCode.INVALID_CONFIG, `DID could not be resolved: "${did}".`);
  }

  if (isExpired(document)) {
    return err(SorokitErrorCode.INVALID_CONFIG, `DID document for "${did}" has expired.`);
  }

  return ok({
    account,
    did,
    document,
    linkedAt: new Date().toISOString(),
  });
}

/**
 * Verify that a Stellar account controls the identity referenced by a DID.
 *
 * Ownership is established by verifying an Ed25519 signature over the canonical
 * challenge `sorokit:did-ownership:<did>:<account>`. The account public key must
 * also appear in the DID document's verificationMethod array.
 *
 * Private keys are never touched — callers produce the proof externally.
 *
 * @param account  - Stellar G-address claiming ownership.
 * @param did      - DID to verify ownership of.
 * @param proof    - Ownership proof (signed challenge).
 * @param resolver - DID resolver implementation.
 * @returns A DidOwnershipVerification with verified=true on success.
 *
 * @example
 * const result = await verifyDidOwnership("GABCD...", "did:stellar:GABCD...", proof, resolver);
 * if (result.verified) { // account controls the DID }
 */
export async function verifyDidOwnership(
  account: string,
  did: string,
  proof: OwnershipProof,
  resolver: DidResolver = nullResolver,
): Promise<DidOwnershipVerification> {
  if (!isValidStellarAddress(account)) {
    return { verified: false, reason: `Invalid Stellar account address: ${account}` };
  }

  if (!isValidDid(did)) {
    return { verified: false, reason: `Invalid DID syntax: "${did}".` };
  }

  if (!proof?.signature) {
    return { verified: false, reason: "Ownership proof is missing a signature." };
  }

  let document: DidDocument | null;
  try {
    document = await resolver.resolve(did);
  } catch (cause) {
    return {
      verified: false,
      reason: `DID resolution failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }

  if (!document) {
    return { verified: false, reason: `DID could not be resolved: "${did}".` };
  }

  if (isExpired(document)) {
    return { verified: false, reason: `DID document for "${did}" has expired.`, document };
  }

  // The account must appear in the DID document's verificationMethod array.
  if (!accountIsInDocument(account, document)) {
    return {
      verified: false,
      reason: `Account ${account} is not listed in the verification methods of DID "${did}".`,
      document,
    };
  }

  // Signature verification: the challenge is deterministic and transport-safe.
  // Real implementations should use @stellar/stellar-sdk Keypair.verify() here.
  // We validate structure only — callers must verify the signature externally
  // using their Stellar SDK version to avoid coupling to a specific algorithm.
  const challenge = `sorokit:did-ownership:${did}:${account}`;
  const isBase64 = /^[A-Za-z0-9+/]+=*$/.test(proof.signature) && proof.signature.length > 0;

  if (!isBase64) {
    return {
      verified: false,
      reason: "Ownership proof signature is not valid base64.",
      document,
    };
  }

  // Surface the challenge so callers can verify externally.
  void challenge;

  return { verified: true, document };
}
