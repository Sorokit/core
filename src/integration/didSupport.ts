import { Keypair } from "@stellar/stellar-sdk";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

/** The DID method name for Stellar DIDs */
export const STELLAR_DID_METHOD = "did:stellar";

/**
 * Standard DID Document interface for Stellar DIDs.
 * Conforms to W3C DID Core specification with Stellar-specific extensions.
 */
export interface StellarDIDDocument {
  "@context": string[];
  id: string;
  controller?: string;
  created?: string;
  expires?: string;
  verificationMethod: Array<{
    id: string;
    type: "StellarVerificationKey2024";
    controller: string;
    publicKeyMultibase: string;
  }>;
  authentication: string[];
  assertionMethod?: string[];
  service?: Array<Record<string, unknown>>;
}

/**
 * Legacy export for backward compatibility.
 */
export type DIDDocument = StellarDIDDocument;

/**
 * Result of DID operations (creation, resolution, linking).
 */
export interface DIDData {
  did: string;
  publicKey: string;
  document: StellarDIDDocument;
  createdAt?: string;
  linkedAt?: string;
  method?: string;
}

/**
 * Interface for a custom DID resolver that can fetch documents from external sources.
 */
export interface DIDResolver {
  resolve(did: string): Promise<StellarDIDDocument | null>;
}

/**
 * Proof of DID ownership (typically a signed challenge).
 */
export interface DIDOwnershipProof {
  challenge?: string;
  signature: string;
  publicKey?: string;
}

const DID_PREFIX = "did:stellar:";
const links = new Map<string, DIDData>();

// Simple validation: G-address must start with G, be exactly 56 chars, and use valid base32
function isValidStellarAddress(publicKey: string): boolean {
  return (
    publicKey.length === 56 &&
    publicKey.startsWith("G") &&
    /^[A-Z2-7]+$/.test(publicKey)
  );
}

function parseDID(did: string): SorokitResult<string> {
  // First check if it's a did:stellar format
  if (did.startsWith(DID_PREFIX)) {
    const publicKey = did.slice(DID_PREFIX.length);
    if (!isValidStellarAddress(publicKey)) {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        `Invalid did:stellar identifier: ${did}`,
      );
    }
    return ok(publicKey);
  }

  // For other DID formats, return a more specific error
  if (did.startsWith("did:")) {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      `Unsupported DID format: ${did}`,
    );
  }

  return err(SorokitErrorCode.INVALID_CONFIG, `Invalid DID format: ${did}`);
}

/**
 * Validate the minimum DID Core shape required by Sorokit's Stellar DID
 * integration. Resolver implementations return untrusted JSON at runtime, so
 * the TypeScript interface alone is not sufficient protection.
 */
function validateResolvedDocument(
  document: unknown,
  did: string,
  publicKey: string,
): SorokitResult<StellarDIDDocument> {
  if (!document || typeof document !== "object") {
    return err(SorokitErrorCode.INVALID_CONFIG, "Resolved DID document must be an object");
  }
  const candidate = document as Partial<StellarDIDDocument>;
  if (candidate.id !== did) {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      `Resolved DID document id must match the requested DID: ${did}`,
    );
  }
  if (
    !Array.isArray(candidate["@context"]) ||
    !candidate["@context"].includes("https://www.w3.org/ns/did/v1")
  ) {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      "Resolved DID document must include the W3C DID Core context",
    );
  }
  if (!Array.isArray(candidate.verificationMethod) || candidate.verificationMethod.length === 0) {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      "Resolved DID document must contain at least one verification method",
    );
  }
  for (const method of candidate.verificationMethod) {
    if (
      !method ||
      typeof method !== "object" ||
      typeof method.id !== "string" ||
      method.type !== "StellarVerificationKey2024" ||
      method.controller !== did ||
      method.publicKeyMultibase !== publicKey
    ) {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        "Resolved DID document contains an invalid Stellar verification method",
      );
    }
  }
  if (
    !Array.isArray(candidate.authentication) ||
    candidate.authentication.length === 0 ||
    candidate.authentication.some((id) => typeof id !== "string")
  ) {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      "Resolved DID document must contain a non-empty authentication array",
    );
  }
  return ok(document as StellarDIDDocument);
}

function documentFor(
  did: string,
  publicKey: string,
  services?: Array<Record<string, unknown>>,
): StellarDIDDocument {
  const method = `${did}#key-1`;
  const now = new Date().toISOString();
  return {
    "@context": [
      "https://www.w3.org/ns/did/v1",
      "https://w3id.org/security/suites/ed25519-2020/v1",
    ],
    id: did,
    controller: did,
    created: now,
    verificationMethod: [
      {
        id: method,
        type: "StellarVerificationKey2024",
        controller: did,
        publicKeyMultibase: publicKey,
      },
    ],
    authentication: [method],
    assertionMethod: [method],
    service: services ?? [],
  };
}

export interface CreateDIDOptions {
  services?: Array<Record<string, unknown>>;
}

export function createDID(
  publicKey: string,
  options?: CreateDIDOptions,
): SorokitResult<DIDData> {
  if (!isValidStellarAddress(publicKey)) {
    return err(SorokitErrorCode.INVALID_ADDRESS, "Invalid Stellar public key");
  }

  const did = `${DID_PREFIX}${publicKey}`;
  const createdAt = new Date().toISOString();
  return ok({
    did,
    publicKey,
    document: documentFor(did, publicKey, options?.services),
    createdAt,
  });
}

export interface ResolveDIDOptions {
  resolver?: DIDResolver;
}

export async function resolveDID(
  did: string,
  options?: ResolveDIDOptions,
): Promise<
  SorokitResult<{
    publicKey: string;
    document: StellarDIDDocument;
    did: string;
  }>
> {
  const parsed = parseDID(did);
  if (parsed.status === "error") {
    // If this is a non-stellar DID without a resolver, provide a specific error
    if (!did.startsWith(DID_PREFIX) && !options?.resolver) {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        `Cannot resolve non-stellar DID without a custom resolver; no resolver was provided`,
      );
    }
    return parsed;
  }

  // Try custom resolver first if provided
  if (options?.resolver) {
    try {
      const resolvedDoc = await options.resolver.resolve(did);
      if (resolvedDoc === null) {
        return err(
          SorokitErrorCode.INVALID_CONFIG,
          "Custom resolver returned no document",
        );
      }
      const documentResult = validateResolvedDocument(resolvedDoc, did, parsed.data);
      if (documentResult.status === "error") return documentResult;
      // Check for expiry
      if (resolvedDoc.expires) {
        const expiresAt = new Date(resolvedDoc.expires);
        if (expiresAt < new Date()) {
          return err(
            SorokitErrorCode.INVALID_CONFIG,
            "Resolved DID document is expired",
          );
        }
      }
      return ok({ publicKey: parsed.data, document: resolvedDoc, did });
    } catch (cause) {
      return err(
        SorokitErrorCode.NETWORK_ERROR,
        "Custom resolver error during DID resolution failed",
        cause,
      );
    }
  }

  // No resolver provided - for non-stellar DIDs, this is an error
  if (!did.startsWith(DID_PREFIX)) {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      "Cannot resolve non-stellar DID without a custom resolver; no resolver was provided",
    );
  }

  // Fall back to local storage or generate on-the-fly for stellar DIDs
  const stored = links.get(did);
  if (stored) {
    return ok({ publicKey: stored.publicKey, document: stored.document, did });
  }

  const document = documentFor(did, parsed.data);
  return ok({ publicKey: parsed.data, document, did });
}

export interface LinkAccountToDIDOptions {
  resolver?: DIDResolver;
}

export async function linkAccountToDID(
  publicKey: string,
  did: string,
  options?: LinkAccountToDIDOptions,
): Promise<SorokitResult<DIDData>> {
  // Validate public key first using simple format validation
  if (!isValidStellarAddress(publicKey)) {
    return err(SorokitErrorCode.INVALID_ADDRESS, "Invalid Stellar public key");
  }

  const resolved = await resolveDID(did, options);
  if (resolved.status === "error") {
    // Re-map certain errors for clarity
    if (resolved.error.code === "NETWORK_ERROR") {
      return err(
        SorokitErrorCode.NETWORK_ERROR,
        `DID resolution failed: ${resolved.error.message}`,
        resolved.error,
      );
    }
    return resolved;
  }

  // Extract public key from document - resolveDID now returns { publicKey, document }
  const { publicKey: resolvedPubKey, document } = resolved.data;
  const documentPublicKey = document.verificationMethod[0]?.publicKeyMultibase;
  if (documentPublicKey !== publicKey) {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      `DID public key mismatch: DID embeds ${documentPublicKey} but supplied key is ${publicKey}`,
    );
  }

  // Parse the public key from the DID
  const parsed = parseDID(did);
  if (parsed.status === "error") return parsed;

  // Build document with proper types to match StellarDIDDocument
  const doc: StellarDIDDocument = {
    "@context": document["@context"],
    id: document.id,
    controller: document.controller ?? did, // Ensure non-undefined
    created: document.created ?? new Date().toISOString(), // Ensure non-undefined
    verificationMethod: document.verificationMethod,
    authentication: document.authentication,
    ...(document.expires ? { expires: document.expires } : {}),
    ...(document.assertionMethod
      ? { assertionMethod: document.assertionMethod }
      : {}),
    ...(document.service && document.service.length > 0
      ? { service: document.service }
      : {}),
  };

  const linked: DIDData = {
    did,
    publicKey: parsed.data,
    document: doc,
    linkedAt: new Date().toISOString(),
    method: STELLAR_DID_METHOD,
  };
  links.set(did, linked);
  return ok(linked);
}

export interface VerifyDIDOwnershipOptions {
  resolver?: DIDResolver;
}

export interface VerifyDIDOwnershipResult {
  verified: boolean;
  reason?: string;
  did: string;
  publicKey: string;
  challenge: string;
  document: StellarDIDDocument;
}

// Overload signatures
export async function verifyDIDOwnership(
  did: string,
  signature: string,
): Promise<SorokitResult<boolean>>;
export async function verifyDIDOwnership(
  did: string,
  publicKey: string,
  proof: DIDOwnershipProof,
  options?: VerifyDIDOwnershipOptions,
): Promise<SorokitResult<VerifyDIDOwnershipResult>>;

// Implementation
export async function verifyDIDOwnership(
  did: string,
  signatureOrPublicKey: string,
  proof?: DIDOwnershipProof,
  options?: VerifyDIDOwnershipOptions,
): Promise<SorokitResult<boolean | VerifyDIDOwnershipResult>> {
  // Check if this is the 2-argument version (simple signature verification)
  if (proof === undefined && options === undefined) {
    const signature = signatureOrPublicKey;
    const parsed = parseDID(did);
    if (parsed.status === "error") return parsed;

    const publicKey = parsed.data;

    if (
      !signature ||
      typeof signature !== "string" ||
      signature.trim() === ""
    ) {
      return err(SorokitErrorCode.INVALID_AUTH, "Signature is required");
    }

    try {
      const verified = Keypair.fromPublicKey(publicKey).verify(
        Buffer.from(did, "utf8"),
        Buffer.from(signature, "base64"),
      );
      return ok(verified);
    } catch (_cause) {
      return ok(false);
    }
  }

  // 4-argument version (complex verification with proof and options)
  const publicKey = signatureOrPublicKey;

  // Validate public key first using simple format validation
  if (!isValidStellarAddress(publicKey)) {
    return err(SorokitErrorCode.INVALID_ADDRESS, "Invalid Stellar public key");
  }

  // Validate proof structure
  if (!proof || !proof.signature || typeof proof.signature !== "string") {
    return err(SorokitErrorCode.INVALID_AUTH, "Proof is missing a signature");
  }

  if (proof.signature.trim() === "") {
    return err(
      SorokitErrorCode.INVALID_AUTH,
      "Proof is missing a signature value",
    );
  }

  const resolved = await resolveDID(did, options);
  if (resolved.status === "error") {
    // Re-map NETWORK_ERROR if it comes from resolver
    if (resolved.error.code === "NETWORK_ERROR") {
      return err(
        SorokitErrorCode.NETWORK_ERROR,
        `DID resolution during verification failed: ${resolved.error.message}`,
        resolved.error,
      );
    }
    return resolved;
  }

  // resolveDID now returns { publicKey, document }
  const { document } = resolved.data;

  // Generate the canonical challenge
  const canonicalChallenge = `sorokit:did-ownership:${did}:${publicKey}`;

  // Verify the public key is listed in the document
  const keyFound = document.verificationMethod.some(
    (m) => m.publicKeyMultibase === publicKey,
  );
  if (!keyFound) {
    return ok({
      verified: false,
      reason: `Public key ${publicKey} is not listed in the verification methods of the document`,
      did,
      publicKey,
      challenge: canonicalChallenge,
      document: document,
    });
  }

  // Verify the signature
  try {
    const verified = Keypair.fromPublicKey(publicKey).verify(
      Buffer.from(canonicalChallenge, "utf8"),
      Buffer.from(proof.signature, "base64"),
    );

    if (verified) {
      return ok({
        verified: true,
        reason: "Signature verification successful",
        did,
        publicKey,
        challenge: canonicalChallenge,
        document: document,
      });
    } else {
      return ok({
        verified: false,
        reason: "Signature verification failed",
        did,
        publicKey,
        challenge: canonicalChallenge,
        document: document,
      });
    }
  } catch (cause) {
    // If it fails to parse/verify, it's likely not valid base64
    return ok({
      verified: false,
      reason: "Signature is not valid base64 encoding",
      did,
      publicKey,
      challenge: canonicalChallenge,
      document: document,
    });
  }
}

export function clearDIDLinks(): void {
  links.clear();
}
