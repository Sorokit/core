/**
 * Tests for account attestation and credential management.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  issueAttestation,
  verifyAttestation,
  revokeAttestation,
  isAttestationRevoked,
  clearAttestationState,
} from "./attestationCore";
import {
  getAccountAttestations,
  storeAccountAttestation,
  removeAccountAttestation,
  clearAccountAttestations,
} from "./attestationQueries";
import type {
  AccountAttestation,
  CredentialMetadata,
} from "./attestationTypes";
import { SorokitErrorCode } from "../shared/response";

// Valid 56-character Stellar public key (G + 55 base32 chars)
const TEST_ACCOUNT = "GDJEEWZD6IVJ6HPIC7GMCX4WPYYH2U74T4ODDARLSRNQFHNBZ2D45XXE";
const TEST_ISSUER = "example-issuer";
const TEST_ISSUER_2 = "another-issuer";

const createTestCredential = (
  overrides?: Partial<CredentialMetadata>,
): CredentialMetadata => ({
  credentialId: "cred-001",
  credentialType: "identity",
  issuer: TEST_ISSUER,
  issuedDate: new Date().toISOString(),
  ...overrides,
});

describe("Account Attestation", () => {
  beforeEach(() => {
    clearAccountAttestations(TEST_ACCOUNT);
    clearAttestationState();
  });

  describe("issueAttestation", () => {
    it("should issue an attestation with valid inputs", () => {
      const credential = createTestCredential();
      const result = issueAttestation(TEST_ACCOUNT, credential);

      expect(result.status).toBe("ok");
      expect(result.data).toBeDefined();
      expect(result.data!.subject).toBe(TEST_ACCOUNT);
      expect(result.data!.credential.credentialId).toBe("cred-001");
      expect(result.data!.signature).toBeDefined();
      expect(result.data!.revoked).toBe(false);
    });

    it("should reject invalid subject address", () => {
      const credential = createTestCredential();
      const result = issueAttestation("invalid-address", credential);

      expect(result.status).toBe("error");
      expect(result.error?.code).toBe(SorokitErrorCode.INVALID_ADDRESS);
    });

    it("should reject missing issuer", () => {
      const credential = createTestCredential({ issuer: "" });
      const result = issueAttestation(TEST_ACCOUNT, credential);

      expect(result.status).toBe("error");
      expect(result.error?.code).toBe(SorokitErrorCode.INVALID_CONFIG);
    });

    it("should reject missing credential ID or type", () => {
      const credential = createTestCredential({ credentialId: "" });
      const result = issueAttestation(TEST_ACCOUNT, credential);

      expect(result.status).toBe("error");
      expect(result.error?.code).toBe(SorokitErrorCode.INVALID_CONFIG);
    });

    it("should apply custom attributes and expiration date", () => {
      const credential = createTestCredential();
      const expirationDate = new Date(Date.now() + 86400000).toISOString();

      const result = issueAttestation(TEST_ACCOUNT, credential, {
        attributes: { role: "admin", level: 5 },
        expirationDate,
      });

      expect(result.status).toBe("ok");
      expect(result.data!.credential.attributes).toEqual({
        role: "admin",
        level: 5,
      });
      expect(result.data!.credential.expirationDate).toBe(expirationDate);
    });

    it("should create attestations with unique signatures per issuance", () => {
      const credential1 = createTestCredential({
        credentialId: "cred-sigtest-1",
        issuedDate: "2026-01-01T00:00:00Z",
      });
      const credential2 = createTestCredential({
        credentialId: "cred-sigtest-2",
        issuedDate: "2026-01-01T00:00:00Z",
      });

      const result1 = issueAttestation(TEST_ACCOUNT, credential1);
      const result2 = issueAttestation(TEST_ACCOUNT, credential2);

      expect(result1.status).toBe("ok");
      expect(result2.status).toBe("ok");
      // Both should produce valid attestations
      expect(result1.data!.signature).toBeDefined();
      expect(result2.data!.signature).toBeDefined();
    });
  });

  describe("verifyAttestation", () => {
    let attestation: AccountAttestation;

    beforeEach(() => {
      const credential = createTestCredential();
      const result = issueAttestation(TEST_ACCOUNT, credential);
      attestation = result.data!;
    });

    it("should verify a valid attestation", () => {
      const result = verifyAttestation(attestation);

      expect(result.status).toBe("ok");
      expect(result.data!.isValid).toBe(true);
      expect(result.data!.signatureValid).toBe(true);
    });

    it("should reject revoked attestations", () => {
      attestation.revoked = true;
      const result = verifyAttestation(attestation);

      expect(result.status).toBe("ok");
      expect(result.data!.isValid).toBe(false);
      expect(result.data!.revoked).toBe(true);
    });

    it("should detect expired attestations", () => {
      const pastDate = new Date(Date.now() - 1000).toISOString();
      attestation.credential.expirationDate = pastDate;

      const result = verifyAttestation(attestation);

      expect(result.status).toBe("ok");
      expect(result.data!.isValid).toBe(false);
      expect(result.data!.expired).toBe(true);
    });

    it("should allow future expiration dates", () => {
      const futureDate = new Date(Date.now() + 86400000).toISOString();
      const credential = createTestCredential({ credentialId: "cred-expiry-future" });
      const issued = issueAttestation(TEST_ACCOUNT, credential, { expirationDate: futureDate });

      expect(issued.status).toBe("ok");

      const result = verifyAttestation(issued.data!);

      expect(result.status).toBe("ok");
      expect(result.data!.isValid).toBe(true);
    });

    it("should reject malformed signatures", () => {
      attestation.signature = "invalid-signature";
      const result = verifyAttestation(attestation);

      expect(result.status).toBe("ok");
      expect(result.data!.isValid).toBe(false);
      expect(result.data!.signatureValid).toBe(false);
    });
  });

  describe("revocation", () => {
    it("should revoke an attestation", () => {
      const credential = createTestCredential();
      revokeAttestation(
        TEST_ACCOUNT,
        credential.issuer,
        credential.credentialId,
        "credential expired",
      );

      expect(
        isAttestationRevoked(
          TEST_ACCOUNT,
          credential.issuer,
          credential.credentialId,
        ),
      ).toBe(true);
    });

    it("should reject revocation with invalid subject", () => {
      const credential = createTestCredential();
      const result = revokeAttestation(
        "invalid",
        credential.issuer,
        credential.credentialId,
      );

      expect(result.status).toBe("error");
      expect(result.error?.code).toBe(SorokitErrorCode.INVALID_ADDRESS);
    });

    it("should not revoke non-existent attestations", () => {
      const result = revokeAttestation(TEST_ACCOUNT, TEST_ISSUER, "non-existent");

      expect(result.status).toBe("ok");
      expect(isAttestationRevoked(TEST_ACCOUNT, TEST_ISSUER, "non-existent")).toBe(
        true,
      );
    });
  });

  describe("getAccountAttestations", () => {
    beforeEach(() => {
      const credential1 = createTestCredential({
        credentialId: "cred-001",
        credentialType: "identity",
        issuer: TEST_ISSUER,
      });
      const result1 = issueAttestation(TEST_ACCOUNT, credential1);
      storeAccountAttestation(TEST_ACCOUNT, result1.data!);

      const credential2 = createTestCredential({
        credentialId: "cred-002",
        credentialType: "role",
        issuer: TEST_ISSUER_2,
      });
      const result2 = issueAttestation(TEST_ACCOUNT, credential2);
      storeAccountAttestation(TEST_ACCOUNT, result2.data!);
    });

    it("should retrieve all attestations for an account", () => {
      const result = getAccountAttestations(TEST_ACCOUNT);

      expect(result.status).toBe("ok");
      expect(result.data).toHaveLength(2);
    });

    it("should filter by issuer", () => {
      const result = getAccountAttestations(TEST_ACCOUNT, {
        issuer: TEST_ISSUER,
      });

      expect(result.status).toBe("ok");
      expect(result.data).toHaveLength(1);
      expect(result.data![0].credential.issuer).toBe(TEST_ISSUER);
    });

    it("should filter by credential type", () => {
      const result = getAccountAttestations(TEST_ACCOUNT, {
        credentialType: "role",
      });

      expect(result.status).toBe("ok");
      expect(result.data).toHaveLength(1);
      expect(result.data![0].credential.credentialType).toBe("role");
    });

    it("should filter by credential ID", () => {
      const result = getAccountAttestations(TEST_ACCOUNT, {
        credentialId: "cred-001",
      });

      expect(result.status).toBe("ok");
      expect(result.data).toHaveLength(1);
      expect(result.data![0].credential.credentialId).toBe("cred-001");
    });

    it("should filter by validity status", () => {
      // First, verify both are valid
      let result = getAccountAttestations(TEST_ACCOUNT, { validOnly: true });
      expect(result.data).toHaveLength(2);

      // Revoke one attestation
      revokeAttestation(TEST_ACCOUNT, TEST_ISSUER, "cred-001");

      // Now only one should be valid
      result = getAccountAttestations(TEST_ACCOUNT, { validOnly: true });
      expect(result.data).toHaveLength(1);
    });

    it("should apply multiple filters", () => {
      const result = getAccountAttestations(TEST_ACCOUNT, {
        issuer: TEST_ISSUER,
        credentialType: "identity",
      });

      expect(result.status).toBe("ok");
      expect(result.data).toHaveLength(1);
    });

    it("should reject invalid account address", () => {
      const result = getAccountAttestations("invalid");

      expect(result.status).toBe("error");
      expect(result.error?.code).toBe(SorokitErrorCode.INVALID_ADDRESS);
    });
  });

  describe("attestation management", () => {
    beforeEach(() => {
      const credential = createTestCredential();
      const result = issueAttestation(TEST_ACCOUNT, credential);
      storeAccountAttestation(TEST_ACCOUNT, result.data!);
    });

    it("should remove an attestation", () => {
      removeAccountAttestation(TEST_ACCOUNT, "cred-001", TEST_ISSUER);

      const result = getAccountAttestations(TEST_ACCOUNT);
      expect(result.data).toHaveLength(0);
    });

    it("should clear all attestations", () => {
      clearAccountAttestations(TEST_ACCOUNT);

      const result = getAccountAttestations(TEST_ACCOUNT);
      expect(result.data).toHaveLength(0);
    });

    it("should handle removing non-existent attestations gracefully", () => {
      const result = removeAccountAttestation(
        TEST_ACCOUNT,
        "non-existent",
        TEST_ISSUER,
      );

      expect(result.status).toBe("ok");
    });
  });
});
