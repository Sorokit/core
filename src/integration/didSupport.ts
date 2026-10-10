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
  const publicKey = did.startsWith(DID_PREFIX)
    ? did.slice(DID_PREFIX.length)
    : "";

  if (!isValidStellarAddress(publicKey)) {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      `Invalid did:stellar identifier: ${did}`,
    );
  }

  return ok(publicKey);
}

function documentFor(
  did: string,
  publicKey: string,
  services?: Array<Record<string, unknown>>,
): StellarDIDDocument {
  const method = `${did}#key-1`;
  return {
    "@context": [
      "https://www.w3.org/ns/did/v1",
      "https://w3id.org/security/suites/ed25519-2020/v1",
    ],
    id: did,
    controller: did,
    created: new Date().toISOString(),
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
): Promise<SorokitResult<DIDData>> {
  const parsed = parseDID(did);
  if (parsed.status === "error") return parsed;

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
      return ok({
        did,
        publicKey: parsed.data,
        document: resolvedDoc,
      });
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
  return ok(
    links.get(did) ?? {
      did,
      publicKey: parsed.data,
      document: documentFor(did, parsed.data),
    },
  );
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

  if (resolved.data.publicKey !== publicKey) {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      `DID public key mismatch: DID embeds ${resolved.data.publicKey} but supplied key is ${publicKey}`,
    );
  }

  const linked = {
    ...resolved.data,
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

export async function verifyDIDOwnership(
  did: string,
  publicKey: string,
  proof: DIDOwnershipProof,
  options?: VerifyDIDOwnershipOptions,
): Promise<SorokitResult<VerifyDIDOwnershipResult>> {
  // Validate public key first using simple format validation
  if (!isValidStellarAddress(publicKey)) {
    return err(SorokitErrorCode.INVALID_ADDRESS, "Invalid Stellar public key");
  }

  // Validate proof structure
  if (!proof.signature || typeof proof.signature !== "string") {
    return err(SorokitErrorCode.INVALID_AUTH, "Proof must include a signature");
  }

  if (proof.signature.trim() === "") {
    return err(
      SorokitErrorCode.INVALID_AUTH,
      "Proof signature is missing a signature value",
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

  // Generate the canonical challenge
  const canonicalChallenge = `sorokit:did-ownership:${did}:${publicKey}`;

  // Verify the public key is listed in the document
  const keyFound = resolved.data.document.verificationMethod.some(
    (m) => m.publicKeyMultibase === publicKey,
  );
  if (!keyFound) {
    return ok({
      verified: false,
      reason: `Public key ${publicKey} is not listed in the verification methods of the document`,
      did,
      publicKey,
      challenge: canonicalChallenge,
      document: resolved.data.document,
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
        document: resolved.data.document,
      });
    } else {
      return ok({
        verified: false,
        reason: "Signature verification failed",
        did,
        publicKey,
        challenge: canonicalChallenge,
        document: resolved.data.document,
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
      document: resolved.data.document,
    });
  }
}

export function clearDIDLinks(): void {
  links.clear();
}
