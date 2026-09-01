/**
 * High-level attestation query API for retrieving account attestations.
 */

import type {
  AccountAttestation,
  GetAccountAttestationsFilter,
} from "./attestationTypes";
import type { SorokitResult } from "../shared/response";
import { SorokitErrorCode, err, ok } from "../shared/response";
import { isAttestationRevoked } from "./attestationCore";
import { isAttestationRevoked } from "./attestationCore";

/**
 * In-memory storage for account attestations.
 * In production, this would be replaced with persistent storage.
 */
const accountAttestationsStore = new Map<string, AccountAttestation[]>();

/**
 * Stores an attestation for an account.
 */
export function storeAccountAttestation(
  account: string,
  attestation: AccountAttestation,
): void {
  if (!accountAttestationsStore.has(account)) {
    accountAttestationsStore.set(account, []);
  }
  accountAttestationsStore.get(account)!.push(attestation);
}

/**
 * Validates if a string is a plausible Stellar public key (G + 55 base32 chars = 56 total).
 */
function isValidAccountAddress(address: string): boolean {
  if (!address || typeof address !== "string") return false;
  if (address.length !== 56) return false;
  if (!address.startsWith("G")) return false;
  return /^[A-Z2-7]{56}$/.test(address);
}

/**
 * Retrieves attestations for an account with optional filtering.
 */
export function getAccountAttestations(
  account: string,
  filter?: GetAccountAttestationsFilter,
): SorokitResult<AccountAttestation[]> {
  if (!isValidAccountAddress(account)) {
    return err<AccountAttestation[]>(
      SorokitErrorCode.INVALID_ADDRESS,
      "Account address is required and must be a valid Stellar public key",
    );
  }

  const attestations = accountAttestationsStore.get(account) || [];

  let filtered = attestations;

  // Filter by issuer
  if (filter?.issuer) {
    filtered = filtered.filter(
      (att) => att.credential.issuer === filter.issuer,
    );
  }

  // Filter by credential type
  if (filter?.credentialType) {
    filtered = filtered.filter(
      (att) => att.credential.credentialType === filter.credentialType,
    );
  }

  // Filter by credential ID
  if (filter?.credentialId) {
    filtered = filtered.filter(
      (att) => att.credential.credentialId === filter.credentialId,
    );
  }

  // Filter by validity status
  if (filter?.validOnly) {
    filtered = filtered.filter((att) => {
      // Check in-object revocation flag
      if (att.revoked) return false;

      // Also check the revocation registry (for attestations revoked after storage)
      if (isAttestationRevoked(att.subject, att.credential.issuer, att.credential.credentialId)) {
        return false;
      }

      // Check expiration
      if (att.credential.expirationDate) {
        const expirationTime = new Date(
          att.credential.expirationDate,
        ).getTime();
        if (Date.now() > expirationTime) return false;
      }

      return true;
    });
  }

  return ok(filtered);
}

/**
 * Removes an attestation from an account's credential set.
 */
export function removeAccountAttestation(
  account: string,
  credentialId: string,
  issuer: string,
): SorokitResult<void> {
  if (!account || typeof account !== "string") {
    return err<void>(
      SorokitErrorCode.INVALID_ADDRESS,
      "Account address is required",
    );
  }

  const attestations = accountAttestationsStore.get(account);
  if (!attestations || attestations.length === 0) {
    return ok(undefined);
  }

  const index = attestations.findIndex(
    (att) =>
      att.credential.credentialId === credentialId &&
      att.credential.issuer === issuer,
  );

  if (index !== -1) {
    attestations.splice(index, 1);
  }

  return ok(undefined);
}

/**
 * Clears all attestations for an account.
 */
export function clearAccountAttestations(account: string): SorokitResult<void> {
  accountAttestationsStore.delete(account);
  return ok(undefined);
}
