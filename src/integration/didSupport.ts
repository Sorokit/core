/**
 * @module didSupport
 *
 * Full W3C DID support for the `did:stellar` method.
 *
 * This is the higher-level integration API — it builds on the lower-level
 * `account/didAssociation` primitives and adds DID creation, resolution,
 * and a full verification pipeline.
 *
 * ## DID Method: did:stellar
 *
 * The `did:stellar` method uses a Stellar public key (G-address) as the
 * method-specific identifier. The resulting DID is entirely self-sovereign:
 * no registry is required for creation, and self-resolution needs no network.
 *
 * **DID format:** `did:stellar:<G-address>`
 *
 * **Example:** `did:stellar:GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBWE3BDE54LQL`
 *
 * ## Key W3C Compliance Notes
 * - DID Documents follow the W3C DID Core 1.0 specification structure.
 * - Verification methods use the `StellarVerificationKey2024` type and
 *   represent the key as a `publicKeyMultibase`-encoded G-address.
 * - Authentication and assertionMethod reference the primary verification
 *   method by fragment ID.
 *
 * ## Usage
 * ```typescript
 * import { createDID, resolveDID, linkAccountToDID, verifyDIDOwnership } from 'sorokit-core';
 *
 * // Create a self-sovereign DID for a Stellar account
 * const result = createDID('GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBWE3BDE54LQL');
 * if (result.status === 'ok') {
 *   console.log(result.data.did); // did:stellar:GAHJJJ...
 * }
 * ```
 *
 * @see https://www.w3.org/TR/did-core/
 */

import { ok, err, SorokitErrorCode, SorokitErrorCategory } from "../shared/response";
import type { SorokitResult } from "../shared/response";

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * The W3C DID method identifier for the Stellar blockchain.
 * All DIDs created by this module are prefixed with this string.
 */
export const STELLAR_DID_METHOD = "did:stellar" as const;

/** Regex for a Stellar ed25519 public key (G-address): 'G' followed by 55 base-32 chars. */
const STELLAR_ADDRESS_PATTERN = /^G[A-Z2-7]{55}$/;

/** Regex for generic DID syntax compliance (method + method-specific-id). */
const DID_GENERIC_PATTERN = /^did:[a-z][a-z0-9-]*:[a-zA-Z0-9._:%-]+$/;

/** Regex that also enforces the did:stellar method with a valid G-address. */
const DID_STELLAR_PATTERN = /^did:stellar:(G[A-Z2-7]{55})$/;

// ── Domain Types ──────────────────────────────────────────────────────────────

/**
 * A W3C DID Core–compliant Verification Method entry specialised for Stellar.
 *
 * The `type` is always `StellarVerificationKey2024` and the key material is
 * encoded as a `publicKeyMultibase` value (the G-address string).
 */
export interface DIDVerificationMethod {
  /** Absolute DID URL for this verification method (e.g. `did:stellar:G...#key-1`). */
  id: string;
  /** Key type constant used by the Stellar DID method. */
  type: "StellarVerificationKey2024";
  /** DID that controls (owns) this key — typically the same DID. */
  controller: string;
  /**
   * Multibase-encoded public key material.
   * For `did:stellar` this is the Stellar G-address, which is already a
   * human-readable encoding of the Ed25519 public key.
   */
  publicKeyMultibase: string;
}

/**
 * A W3C DID Core–compliant service endpoint definition.
 *
 * Services allow the DID subject to advertise where others can interact with
 * them (e.g. a Stellar federation server, a Horizon endpoint, a messaging
 * service, etc.).
 */
export interface DIDServiceEndpoint {
  /**
   * Absolute DID URL for this service (e.g. `did:stellar:G...#federation`).
   */
  id: string;
  /**
   * Service type string.
   * Well-known types include `LinkedDomains`, `MessagingService`, and
   * `StellarFederationServer`.
   */
  type: string;
  /**
   * The service endpoint itself — either a URL string or a structured object
   * for services that require multiple fields.
   */
  serviceEndpoint: string | Record<string, unknown>;
}

/**
 * A fully-formed W3C DID Document for the `did:stellar` method.
 *
 * This is the canonical document returned by resolution and included in
 * association / verification results. It extends the base DID Document
 * structure with Stellar-specific context entries.
 */
export interface StellarDIDDocument {
  /** JSON-LD context — always includes the W3C DID context. */
  "@context": string[];
  /** The subject DID this document describes. */
  id: string;
  /**
   * The DID(s) that are authorised to make changes to this document.
   * For self-sovereign `did:stellar` DIDs this is always the same as `id`.
   */
  controller: string | string[];
  /**
   * Cryptographic verification methods (keys) associated with the DID subject.
   * At minimum one entry is always present: the primary Stellar key.
   */
  verificationMethod: DIDVerificationMethod[];
  /**
   * References to verification methods that can be used to authenticate as
   * the DID subject. Contains fragment IDs or full DID URLs.
   */
  authentication: string[];
  /**
   * References to verification methods that can be used to issue verifiable
   * credentials on behalf of the DID subject.
   */
  assertionMethod: string[];
  /**
   * Optional service endpoints advertised by the DID subject.
   */
  service?: DIDServiceEndpoint[];
  /**
   * Optional ISO-8601 timestamp indicating when this document expires.
   * Expired documents are rejected by all integration functions.
   */
  expires?: string;
  /**
   * Optional ISO-8601 timestamp indicating when this document was created.
   */
  created?: string;
  /**
   * Optional ISO-8601 timestamp indicating when this document was last
   * updated. Present when the document has been updated after creation.
   */
  updated?: string;
}

/**
 * The result produced by {@link createDID}.
 *
 * Contains the full DID string, the originating public key, the complete
 * self-describing DID document, and the creation timestamp.
 */
export interface DIDInfo {
  /** The fully-qualified `did:stellar:<G-address>` string. */
  did: string;
  /** The Stellar G-address that the DID was generated from. */
  publicKey: string;
  /** The self-describing W3C DID Document for this DID. */
  document: StellarDIDDocument;
  /** ISO-8601 timestamp of when this DIDInfo was created. */
  createdAt: string;
}

/**
 * A record that associates a Stellar account public key with a resolved DID.
 *
 * Returned by {@link linkAccountToDID}. The `document` is the live DID
 * Document that was fetched (or self-resolved) at link time.
 */
export interface DIDLinkRecord {
  /** The Stellar G-address that was linked. */
  publicKey: string;
  /** The DID string that was linked. */
  did: string;
  /** The resolved DID document at the time of linking. */
  document: StellarDIDDocument;
  /** ISO-8601 timestamp of when the link was created. */
  linkedAt: string;
  /** The DID method — always `'did:stellar'` for this module. */
  method: typeof STELLAR_DID_METHOD;
}

/**
 * Ownership proof provided to {@link verifyDIDOwnership}.
 *
 * The `signature` field must be a base64-encoded Ed25519 signature over the
 * canonical challenge: `sorokit:did-ownership:<did>:<publicKey>`.
 *
 * Production callers should produce this proof using the Stellar SDK's
 * `Keypair.sign()` method and encode the result with `Buffer.from(...).toString('base64')`.
 */
export interface DIDOwnershipProof {
  /**
   * Base64-encoded Ed25519 signature over the canonical challenge message.
   *
   * Challenge format: `sorokit:did-ownership:<did>:<publicKey>`
   */
  signature: string;
}

/**
 * The result of a {@link verifyDIDOwnership} call.
 *
 * When `verified` is `true`, the public key was found in the DID document's
 * `verificationMethod` array and the proof's signature was structurally
 * valid base64. When `false`, `reason` explains why verification failed.
 */
export interface DIDVerificationResult {
  /** Whether the ownership claim was successfully verified. */
  verified: boolean;
  /** The DID that was verified. */
  did: string;
  /** The Stellar public key that was checked against the document. */
  publicKey: string;
  /**
   * The deterministic challenge string that the `proof.signature` should
   * have been produced over.
   *
   * Format: `sorokit:did-ownership:<did>:<publicKey>`
   */
  challenge: string;
  /**
   * The resolved DID document at the time of verification.
   * Present when resolution succeeded (even if verification ultimately failed).
   */
  document?: StellarDIDDocument;
  /** Human-readable explanation when `verified` is `false`. */
  reason?: string;
}

// ── Option Types ──────────────────────────────────────────────────────────────

/**
 * Options for {@link createDID}.
 */
export interface CreateDIDOptions {
  /**
   * Optional service endpoints to embed in the generated DID document.
   * Useful for advertising a Stellar federation server or other services.
   */
  services?: DIDServiceEndpoint[];
}

/**
 * Pluggable DID resolver interface for {@link resolveDID}, {@link linkAccountToDID},
 * and {@link verifyDIDOwnership}.
 *
 * Implement this interface to connect sorokit-core to any DID registry or
 * custom resolution backend.
 *
 * @example
 * ```typescript
 * const myResolver: DIDResolver = {
 *   async resolve(did) {
 *     const doc = await myRegistry.fetch(did);
 *     return doc ?? null;
 *   },
 * };
 * ```
 */
export interface DIDResolver {
  /**
   * Resolve a DID to its document.
   *
   * @param did - The fully-qualified DID string to resolve.
   * @returns The DID document, or `null` if the DID cannot be found.
   * @throws Any network or parsing error is propagated and caught by the
   *         integration functions, which convert it to a `NETWORK_ERROR` result.
   */
  resolve(did: string): Promise<StellarDIDDocument | null>;
}

/**
 * Options for {@link resolveDID}.
 */
export interface ResolveDIDOptions {
  /**
   * Custom DID resolver. When omitted, `did:stellar` DIDs are resolved
   * via self-resolution (reconstructed from the embedded public key).
   */
  resolver?: DIDResolver;
  /**
   * Timeout in milliseconds for the resolution network call.
   * Defaults to `10_000` (10 seconds).
   * Only applies when a custom `resolver` is provided.
   */
  timeoutMs?: number;
}

/**
 * Options for {@link linkAccountToDID}.
 */
export interface LinkDIDOptions {
  /**
   * Custom DID resolver used to confirm the DID document exists.
   * Falls back to self-resolution for `did:stellar` when omitted.
   */
  resolver?: DIDResolver;
}

/**
 * Options for {@link verifyDIDOwnership}.
 */
export interface VerifyDIDOptions {
  /**
   * Custom DID resolver used to fetch the DID document for verification.
   * Falls back to self-resolution for `did:stellar` when omitted.
   */
  resolver?: DIDResolver;
}

// ── Private Helpers ───────────────────────────────────────────────────────────

/** Returns `true` when the string is a structurally valid Stellar G-address. */
function isValidStellarAddress(address: string): boolean {
  return STELLAR_ADDRESS_PATTERN.test(address);
}

/** Returns `true` when `did` matches the generic W3C DID syntax. */
function isValidDid(did: string): boolean {
  return DID_GENERIC_PATTERN.test(did);
}

/**
 * Extracts the G-address embedded in a `did:stellar:<G-address>` string.
 * Returns `null` if `did` is not a valid `did:stellar` DID.
 */
function extractStellarKey(did: string): string | null {
  const m = DID_STELLAR_PATTERN.exec(did);
  return m ? (m[1] ?? null) : null;
}

/**
 * Returns `true` when `document.expires` is set and the document is past its
 * expiry date.
 */
function isDocumentExpired(document: StellarDIDDocument): boolean {
  if (!document.expires) return false;
  return Date.parse(document.expires) < Date.now();
}

/**
 * Returns `true` when `publicKey` appears in any `verificationMethod` of
 * `document` (checked against `publicKeyMultibase` and `controller`).
 */
function publicKeyIsInDocument(publicKey: string, document: StellarDIDDocument): boolean {
  return document.verificationMethod.some(
    (vm) => vm.publicKeyMultibase === publicKey || vm.controller === publicKey,
  );
}

/**
 * Validates that a base64 string is non-empty and uses only base64 characters
 * (standard alphabet, with or without padding).
 */
function isValidBase64(value: string): boolean {
  return /^[A-Za-z0-9+/]+=*$/.test(value) && value.length > 0;
}

/**
 * Build a canonical self-describing {@link StellarDIDDocument} from a public key.
 *
 * This is used both by {@link createDID} and by the self-resolution fallback
 * inside {@link resolveDID}.
 *
 * @param publicKey  - Stellar G-address.
 * @param services   - Optional service endpoints to embed.
 * @param createdAt  - ISO-8601 creation timestamp (defaults to now).
 * @returns A fully-formed {@link StellarDIDDocument}.
 */
function buildStellarDIDDocument(
  publicKey: string,
  services?: DIDServiceEndpoint[],
  createdAt?: string,
): StellarDIDDocument {
  const did = `${STELLAR_DID_METHOD}:${publicKey}`;
  const keyId = `${did}#key-1`;
  const now = createdAt ?? new Date().toISOString();

  const verificationMethod: DIDVerificationMethod = {
    id: keyId,
    type: "StellarVerificationKey2024",
    controller: did,
    publicKeyMultibase: publicKey,
  };

  const doc: StellarDIDDocument = {
    "@context": [
      "https://www.w3.org/ns/did/v1",
      "https://w3id.org/security/suites/ed25519-2020/v1",
    ],
    id: did,
    controller: did,
    verificationMethod: [verificationMethod],
    authentication: [keyId],
    assertionMethod: [keyId],
    created: now,
  };

  if (services && services.length > 0) {
    doc.service = services;
  }

  return doc;
}

/**
 * Resolve a DID using a custom resolver with a timeout guard.
 *
 * @param did       - DID to resolve.
 * @param resolver  - External resolver implementation.
 * @param timeoutMs - Abort the resolution after this many milliseconds.
 */
async function resolveWithTimeout(
  did: string,
  resolver: DIDResolver,
  timeoutMs: number,
): Promise<StellarDIDDocument | null> {
  return new Promise<StellarDIDDocument | null>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`DID resolution timed out after ${timeoutMs}ms.`)),
      timeoutMs,
    );
    resolver
      .resolve(did)
      .then((doc) => {
        clearTimeout(timer);
        resolve(doc);
      })
      .catch((e: unknown) => {
        clearTimeout(timer);
        reject(e);
      });
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate a `did:stellar` DID and its self-describing W3C DID Document.
 *
 * No network call is required — the DID is derived directly from the Stellar
 * public key. The resulting document is immediately usable as a verifiable
 * identity anchored to the Stellar blockchain.
 *
 * @param publicKey - A Stellar G-address (56 characters, begins with 'G').
 * @param options   - Optional configuration, including service endpoints.
 * @returns `ok(DIDInfo)` on success, or `err` if the public key is invalid.
 *
 * @example
 * ```typescript
 * const result = createDID('GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBWE3BDE54LQL');
 * if (result.status === 'ok') {
 *   console.log(result.data.did);      // did:stellar:GAHJJJ...
 *   console.log(result.data.document); // Full W3C DID Document
 * }
 * ```
 */
export function createDID(
  publicKey: string,
  options?: CreateDIDOptions,
): SorokitResult<DIDInfo> {
  if (!isValidStellarAddress(publicKey)) {
    return err(
      SorokitErrorCode.INVALID_ADDRESS,
      `Invalid Stellar public key: "${publicKey}". ` +
        `Expected a G-address (56 characters starting with 'G').`,
      undefined,
      undefined,
      {
        context: { operation: "createDID", parameters: { publicKey } },
        recovery: { retryable: false, action: "Supply a valid Stellar G-address." },
      },
    );
  }

  const createdAt = new Date().toISOString();
  const did = `${STELLAR_DID_METHOD}:${publicKey}`;
  const document = buildStellarDIDDocument(publicKey, options?.services, createdAt);

  return ok<DIDInfo>({
    did,
    publicKey,
    document,
    createdAt,
  });
}

/**
 * Resolve a `did:stellar` DID to its W3C DID Document.
 *
 * Resolution strategy:
 * 1. If `options.resolver` is provided, that resolver is called. The call is
 *    bounded by `options.timeoutMs` (default 10 s).
 * 2. If no resolver is supplied and the DID is a valid `did:stellar:<G-address>`,
 *    the document is self-resolved by reconstructing it from the embedded key.
 *    This requires no network access.
 * 3. Any other DID format without a resolver → `INVALID_CONFIG` error.
 *
 * @param did     - The fully-qualified DID string to resolve.
 * @param options - Resolution options (custom resolver, timeout).
 * @returns `Promise<SorokitResult<StellarDIDDocument>>`.
 *
 * @example
 * ```typescript
 * // Self-resolution (no network)
 * const result = await resolveDID('did:stellar:GAHJJJ...');
 *
 * // Custom resolver
 * const result = await resolveDID('did:stellar:GAHJJJ...', { resolver: myResolver });
 * ```
 */
export async function resolveDID(
  did: string,
  options?: ResolveDIDOptions,
): Promise<SorokitResult<StellarDIDDocument>> {
  if (!isValidDid(did)) {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      `Invalid DID syntax: "${did}". Expected format: did:<method>:<id>.`,
      undefined,
      undefined,
      {
        context: { operation: "resolveDID", parameters: { did } },
        recovery: {
          retryable: false,
          action: "Provide a syntactically valid DID string.",
        },
      },
    );
  }

  const timeoutMs = options?.timeoutMs ?? 10_000;

  // ── Path 1: Custom resolver ──────────────────────────────────────────────
  if (options?.resolver) {
    let document: StellarDIDDocument | null;
    try {
      document = await resolveWithTimeout(did, options.resolver, timeoutMs);
    } catch (cause) {
      const isTimeout =
        cause instanceof Error && cause.message.includes("timed out");
      return err(
        isTimeout ? SorokitErrorCode.OPERATION_TIMEOUT : SorokitErrorCode.NETWORK_ERROR,
        isTimeout
          ? `DID resolution timed out for "${did}" after ${timeoutMs}ms.`
          : `DID resolution failed for "${did}": ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
        undefined,
        {
          context: { operation: "resolveDID", parameters: { did } },
          recovery: {
            retryable: true,
            action: isTimeout
              ? "Increase timeoutMs or check resolver connectivity."
              : "Check resolver connectivity and retry.",
          },
        },
      );
    }

    if (!document) {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        `DID could not be resolved: "${did}". The resolver returned no document.`,
        undefined,
        undefined,
        {
          context: { operation: "resolveDID", parameters: { did } },
          recovery: { retryable: false, action: "Verify the DID exists in the resolver's registry." },
        },
      );
    }

    if (isDocumentExpired(document)) {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        `DID document for "${did}" has expired (expires: ${document.expires}).`,
        undefined,
        undefined,
        {
          context: { operation: "resolveDID", parameters: { did } },
          recovery: {
            retryable: false,
            action: "The DID subject must renew or re-publish their DID document.",
          },
        },
      );
    }

    return ok(document);
  }

  // ── Path 2: Self-resolution for did:stellar ──────────────────────────────
  const stellarKey = extractStellarKey(did);
  if (stellarKey) {
    const document = buildStellarDIDDocument(stellarKey);
    return ok(document);
  }

  // ── Path 3: Unresolvable DID (non-stellar method, no resolver) ───────────
  return err(
    SorokitErrorCode.INVALID_CONFIG,
    `Cannot resolve DID "${did}": no resolver was provided and this DID does not use the did:stellar method.`,
    undefined,
    undefined,
    {
      context: { operation: "resolveDID", parameters: { did } },
      recovery: {
        retryable: false,
        action: "Provide a DIDResolver implementation via options.resolver.",
      },
    },
  );
}

/**
 * Associate a Stellar account public key with a DID.
 *
 * Validates both the public key and the DID, then resolves the DID document to
 * confirm it exists and is not expired. For self-sovereign `did:stellar` DIDs,
 * also validates that the DID's embedded key matches the supplied public key.
 *
 * @param publicKey - A Stellar G-address to associate.
 * @param did       - The DID string to link the account to.
 * @param options   - Optional resolver for document confirmation.
 * @returns `Promise<SorokitResult<DIDLinkRecord>>`.
 *
 * @example
 * ```typescript
 * const key = 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBWE3BDE54LQL';
 * const result = await linkAccountToDID(key, `did:stellar:${key}`);
 * if (result.status === 'ok') {
 *   console.log(result.data.linkedAt);
 * }
 * ```
 */
export async function linkAccountToDID(
  publicKey: string,
  did: string,
  options?: LinkDIDOptions,
): Promise<SorokitResult<DIDLinkRecord>> {
  // Validate public key
  if (!isValidStellarAddress(publicKey)) {
    return err(
      SorokitErrorCode.INVALID_ADDRESS,
      `Invalid Stellar public key: "${publicKey}". Expected a G-address.`,
      undefined,
      undefined,
      {
        context: { operation: "linkAccountToDID", parameters: { publicKey, did } },
        recovery: { retryable: false, action: "Supply a valid Stellar G-address." },
      },
    );
  }

  // Validate DID syntax
  if (!isValidDid(did)) {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      `Invalid DID syntax: "${did}". Expected format: did:<method>:<id>.`,
      undefined,
      undefined,
      {
        context: { operation: "linkAccountToDID", parameters: { publicKey, did } },
        recovery: {
          retryable: false,
          action: "Provide a syntactically valid DID string.",
        },
      },
    );
  }

  // For did:stellar DIDs, validate key/DID consistency
  const embeddedKey = extractStellarKey(did);
  if (embeddedKey !== null && embeddedKey !== publicKey) {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      `Key mismatch: the public key "${publicKey}" does not match the key embedded in the DID "${did}". ` +
        `For self-sovereign did:stellar DIDs the public key must equal the method-specific identifier.`,
      undefined,
      undefined,
      {
        context: { operation: "linkAccountToDID", parameters: { publicKey, did } },
        recovery: {
          retryable: false,
          action:
            "Use the same key that was used to create the DID, or use a non-stellar DID method with a custom resolver.",
        },
      },
    );
  }

  // Resolve the DID document to confirm existence
  const resolveResult = await resolveDID(did, options?.resolver ? { resolver: options.resolver } : undefined);
  if (resolveResult.status === "error") {
    return err(
      resolveResult.error.code,
      `Cannot link account to DID — resolution failed: ${resolveResult.error.message}`,
      resolveResult.error.cause,
      undefined,
      {
        context: { operation: "linkAccountToDID", parameters: { publicKey, did } },
        ...(resolveResult.error.recovery !== undefined
          ? { recovery: resolveResult.error.recovery }
          : {}),
      },
    );
  }

  return ok<DIDLinkRecord>({
    publicKey,
    did,
    document: resolveResult.data,
    linkedAt: new Date().toISOString(),
    method: STELLAR_DID_METHOD,
  });
}

/**
 * Verify that a Stellar account controls the identity referenced by a DID.
 *
 * Ownership is established by:
 * 1. Resolving the DID document.
 * 2. Confirming the `publicKey` appears in `verificationMethod[]`.
 * 3. Validating the `proof.signature` is structurally valid base64
 *    (production callers must verify the Ed25519 signature externally using
 *    the Stellar SDK — this module avoids coupling to a specific SDK version).
 *
 * The canonical challenge exposed in the result is:
 * `sorokit:did-ownership:<did>:<publicKey>`
 *
 * Private keys are never touched by this function.
 *
 * @param did       - The DID whose ownership is being asserted.
 * @param publicKey - The Stellar G-address claiming ownership.
 * @param proof     - The ownership proof containing a base64-encoded signature.
 * @param options   - Optional resolver.
 * @returns `Promise<SorokitResult<DIDVerificationResult>>`.
 *
 * @example
 * ```typescript
 * const result = await verifyDIDOwnership(
 *   'did:stellar:GAHJJJ...',
 *   'GAHJJJ...',
 *   { signature: base64EncodedSignature },
 * );
 * if (result.status === 'ok' && result.data.verified) {
 *   console.log('Ownership verified!', result.data.challenge);
 * }
 * ```
 */
export async function verifyDIDOwnership(
  did: string,
  publicKey: string,
  proof: DIDOwnershipProof,
  options?: VerifyDIDOptions,
): Promise<SorokitResult<DIDVerificationResult>> {
  const challenge = `sorokit:did-ownership:${did}:${publicKey}`;

  // Validate public key
  if (!isValidStellarAddress(publicKey)) {
    return err(
      SorokitErrorCode.INVALID_ADDRESS,
      `Invalid Stellar public key: "${publicKey}". Expected a G-address.`,
      undefined,
      undefined,
      {
        context: { operation: "verifyDIDOwnership", parameters: { did, publicKey } },
        recovery: { retryable: false, action: "Supply a valid Stellar G-address." },
      },
    );
  }

  // Validate DID syntax
  if (!isValidDid(did)) {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      `Invalid DID syntax: "${did}". Expected format: did:<method>:<id>.`,
      undefined,
      undefined,
      {
        context: { operation: "verifyDIDOwnership", parameters: { did, publicKey } },
        recovery: {
          retryable: false,
          action: "Provide a syntactically valid DID string.",
        },
      },
    );
  }

  // Validate proof exists and has a signature
  if (!proof?.signature) {
    return err(
      SorokitErrorCode.INVALID_AUTH,
      "Ownership proof is missing a signature field.",
      undefined,
      undefined,
      {
        context: { operation: "verifyDIDOwnership", parameters: { did, publicKey } },
        recovery: {
          retryable: false,
          action:
            `Sign the challenge "${challenge}" with the account's private key and provide the base64 result in proof.signature.`,
        },
      },
    );
  }

  // Validate proof signature is valid base64
  if (!isValidBase64(proof.signature)) {
    return ok<DIDVerificationResult>({
      verified: false,
      did,
      publicKey,
      challenge,
      reason: "Ownership proof signature is not valid base64.",
    });
  }

  // Resolve the DID document
  const resolveResult = await resolveDID(did, options?.resolver ? { resolver: options.resolver } : undefined);
  if (resolveResult.status === "error") {
    return err(
      resolveResult.error.code,
      `DID verification failed — resolution error: ${resolveResult.error.message}`,
      resolveResult.error.cause,
      undefined,
      {
        context: { operation: "verifyDIDOwnership", parameters: { did, publicKey } },
        ...(resolveResult.error.recovery !== undefined
          ? { recovery: resolveResult.error.recovery }
          : {}),
      },
    );
  }

  const document = resolveResult.data;

  // Check expiry
  if (isDocumentExpired(document)) {
    return ok<DIDVerificationResult>({
      verified: false,
      did,
      publicKey,
      challenge,
      document,
      reason: `DID document for "${did}" has expired (expires: ${document.expires}).`,
    });
  }

  // Confirm the public key appears in the document's verificationMethod array
  if (!publicKeyIsInDocument(publicKey, document)) {
    return ok<DIDVerificationResult>({
      verified: false,
      did,
      publicKey,
      challenge,
      document,
      reason:
        `Public key "${publicKey}" is not listed in the verification methods of DID "${did}". ` +
        `The account is not authorised to claim ownership of this identity.`,
    });
  }

  // All structural checks passed. Return verified=true and expose the challenge
  // so the caller can complete the Ed25519 signature verification if needed.
  return ok<DIDVerificationResult>({
    verified: true,
    did,
    publicKey,
    challenge,
    document,
  });
}
