/**
 * Account attestation types for credential management.
 * Supports issuing, verifying, and querying cryptographically signed credentials.
 */

/**
 * Metadata associated with an attestation credential.
 */
export interface CredentialMetadata {
  /** Unique identifier for this credential type */
  credentialId: string;
  /** Type classification of the credential (e.g., "identity", "role", "membership") */
  credentialType: string;
  /** Issuer's public key or identifier */
  issuer: string;
  /** ISO 8601 timestamp when credential was issued */
  issuedDate: string;
  /** ISO 8601 timestamp when credential expires (optional) */
  expirationDate?: string;
  /** Custom attributes associated with the credential */
  attributes?: Record<string, unknown>;
}

/**
 * Account attestation representing a cryptographically signed credential.
 */
export interface AccountAttestation {
  /** Stellar account public key that this attestation is bound to */
  subject: string;
  /** Credential metadata */
  credential: CredentialMetadata;
  /** Cryptographic signature payload */
  signature: string;
  /** Algorithm used for signing (e.g., "Ed25519") */
  signatureAlgorithm: string;
  /** Indicates if this attestation has been revoked */
  revoked: boolean;
  /** Reason for revocation (if revoked) */
  revocationReason?: string;
  /** ISO 8601 timestamp when attestation was created */
  createdAt: string;
}

/**
 * Filter options for querying account attestations.
 */
export interface GetAccountAttestationsFilter {
  /** Filter by issuer identifier */
  issuer?: string;
  /** Filter by credential type */
  credentialType?: string;
  /** Filter by validity status (true = valid only, false = include revoked) */
  validOnly?: boolean;
  /** Filter by credential ID */
  credentialId?: string;
}

/**
 * Attestation verification result.
 */
export interface AttestationVerificationResult {
  isValid: boolean;
  reason?: string;
  expired?: boolean;
  revoked?: boolean;
  signatureValid?: boolean;
}

/**
 * Options for issuing an attestation.
 */
export interface IssueAttestationOptions {
  /** Custom attributes to include in credential metadata */
  attributes?: Record<string, unknown>;
  /** Expiration date for the credential (ISO 8601 format) */
  expirationDate?: string;
}

/**
 * Internal state for tracking attestation revocations.
 */
export interface RevocationEntry {
  /** Subject account public key */
  subject: string;
  /** Issuer identifier */
  issuer: string;
  /** Credential ID */
  credentialId: string;
  /** Reason for revocation */
  reason?: string;
  /** Timestamp when revocation was recorded */
  revokedAt: string;
}
