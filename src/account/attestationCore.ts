/**
 * Core attestation functionality for issuing and verifying credentials.
 */

import crypto from "crypto";
import type {
  AccountAttestation,
  AttestationVerificationResult,
  CredentialMetadata,
  IssueAttestationOptions,
  RevocationEntry,
} from "./attestationTypes";
import type { SorokitResult } from "../shared/response";
import { SorokitErrorCode, err, ok } from "../shared/response";

/**
 * Validates if a Stellar public key is valid format.
 */
function isValidStellarPublicKey(publicKey: string): boolean {
  if (!publicKey || typeof publicKey !== "string") return false;
  if (publicKey.length !== 56) return false;
  if (!publicKey.startsWith("G")) return false;
  // Stellar public keys are base32 encoded with a specific character set
  // Valid base32 chars: A-Z and 2-7
  return /^[A-Z2-7]{56}$/.test(publicKey);
}

/**
 * Global registry for revoked attestations.
 * In production, this should be persisted to a database or ledger.
 */
const revocationRegistry = new Map<string, RevocationEntry>();

/**
 * Registry to track issued attestations for duplicate detection.
 * Cleared by clearIssuanceRegistry() (used in tests).
 */
const issuanceRegistry = new Set<string>();

/**
 * Generates a deterministic signature for an attestation payload.
 * Uses a HMAC-SHA256 of the canonical payload + issuer.
 * In production, this would use the issuer's private key for real Ed25519 signing.
 */
function generateSignature(payload: string, issuer: string): string {
  const combined = `${payload}|${issuer}`;
  return crypto.createHmac("sha256", issuer).update(combined).digest("hex");
}

/**
 * Creates a canonical payload from credential metadata for signing.
 */
function createPayload(subject: string, credential: CredentialMetadata): string {
  const payload = {
    subject,
    credentialId: credential.credentialId,
    credentialType: credential.credentialType,
    issuer: credential.issuer,
    issuedDate: credential.issuedDate,
    expirationDate: credential.expirationDate || "",
  };
  return JSON.stringify(payload, Object.keys(payload).sort());
}

/**
 * Issues a new attestation for an account with deterministic signing.
 */
export function issueAttestation(
  subject: string,
  credential: CredentialMetadata,
  options?: IssueAttestationOptions,
): SorokitResult<AccountAttestation> {
  // Validate subject
  if (!isValidStellarPublicKey(subject)) {
    return err<AccountAttestation>(
      SorokitErrorCode.INVALID_ADDRESS,
      `Invalid subject account: ${subject}`,
    );
  }

  // Validate issuer
  if (!credential.issuer || typeof credential.issuer !== "string") {
    return err<AccountAttestation>(
      SorokitErrorCode.INVALID_CONFIG,
      "Credential issuer is required and must be a string",
    );
  }

  // Validate credential metadata
  if (!credential.credentialId || !credential.credentialType) {
    return err<AccountAttestation>(
      SorokitErrorCode.INVALID_CONFIG,
      "Credential ID and type are required",
    );
  }

  // Check for duplicate attestation
  const duplicateKey = `${subject}|${credential.issuer}|${credential.credentialId}`;
  if (issuanceRegistry.has(duplicateKey)) {
    return err<AccountAttestation>(
      SorokitErrorCode.INVALID_CONFIG,
      `Duplicate attestation already exists for issuer ${credential.issuer} and credential ${credential.credentialId}`,
    );
  }

  // Create credential with optional fields
  const fullCredential: CredentialMetadata = {
    ...credential,
    issuedDate: credential.issuedDate || new Date().toISOString(),
    expirationDate: options?.expirationDate || credential.expirationDate,
    attributes: options?.attributes || credential.attributes,
  };

  // Create payload and signature
  const payload = createPayload(subject, fullCredential);
  const signature = generateSignature(payload, credential.issuer);

  const attestation: AccountAttestation = {
    subject,
    credential: fullCredential,
    signature,
    signatureAlgorithm: "Ed25519",
    revoked: false,
    createdAt: new Date().toISOString(),
  };

  // Track issuance for duplicate detection
  issuanceRegistry.add(duplicateKey);

  return ok(attestation);
}

/**
 * Verifies an attestation's cryptographic signature, subject, and expiration.
 */
export function verifyAttestation(
  attestation: AccountAttestation,
): SorokitResult<AttestationVerificationResult> {
  // Check revocation status
  if (attestation.revoked) {
    return ok({
      isValid: false,
      reason: "Attestation has been revoked",
      revoked: true,
    });
  }

  // Validate subject format
  if (!isValidStellarPublicKey(attestation.subject)) {
    return ok({
      isValid: false,
      reason: "Invalid subject account",
      signatureValid: false,
    });
  }

  // Check expiration
  if (attestation.credential.expirationDate) {
    const expirationTime = new Date(
      attestation.credential.expirationDate,
    ).getTime();
    const now = Date.now();

    if (now > expirationTime) {
      return ok({
        isValid: false,
        reason: "Attestation has expired",
        expired: true,
      });
    }
  }

  // Verify signature
  const payload = createPayload(
    attestation.subject,
    attestation.credential,
  );
  const expectedSignature = generateSignature(
    payload,
    attestation.credential.issuer,
  );

  const signatureValid = attestation.signature === expectedSignature;

  if (!signatureValid) {
    return ok({
      isValid: false,
      reason: "Attestation signature verification failed",
      signatureValid: false,
    });
  }

  return ok({
    isValid: true,
    signatureValid: true,
  });
}

/**
 * Revokes an attestation by subject, issuer, and credential ID.
 */
export function revokeAttestation(
  subject: string,
  issuer: string,
  credentialId: string,
  reason?: string,
): SorokitResult<void> {
  if (!isValidStellarPublicKey(subject)) {
    return err<void>(
      SorokitErrorCode.INVALID_ADDRESS,
      `Invalid subject account: ${subject}`,
    );
  }

  const key = `${subject}|${issuer}|${credentialId}`;
  revocationRegistry.set(key, {
    subject,
    issuer,
    credentialId,
    reason,
    revokedAt: new Date().toISOString(),
  });

  return ok(undefined);
}

/**
 * Checks if an attestation is revoked.
 */
export function isAttestationRevoked(
  subject: string,
  issuer: string,
  credentialId: string,
): boolean {
  const key = `${subject}|${issuer}|${credentialId}`;
  return revocationRegistry.has(key);
}

/**
 * Clears all attestation state (revocations and issuance records).
 * Intended for use in tests and application resets.
 */
export function clearAttestationState(): void {
  revocationRegistry.clear();
  issuanceRegistry.clear();
}
