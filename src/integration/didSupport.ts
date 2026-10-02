import { Keypair } from "@stellar/stellar-sdk";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

export interface DIDDocument {
  "@context": string[];
  id: string;
  verificationMethod: Array<{
    id: string;
    type: "Ed25519VerificationKey2020";
    controller: string;
    publicKeyMultibase: string;
  }>;
  authentication: string[];
  service: Array<Record<string, unknown>>;
}

export interface DIDData {
  did: string;
  publicKey: string;
  document: DIDDocument;
  linkedAt?: string;
}

const DID_PREFIX = "did:stellar:";
const links = new Map<string, DIDData>();

function parseDID(did: string): SorokitResult<string> {
  const publicKey = did.startsWith(DID_PREFIX) ? did.slice(DID_PREFIX.length) : "";
  try {
    Keypair.fromPublicKey(publicKey);
    return ok(publicKey);
  } catch (cause) {
    return err(SorokitErrorCode.INVALID_CONFIG, `Invalid did:stellar identifier: ${did}`, cause);
  }
}

function documentFor(did: string, publicKey: string): DIDDocument {
  const method = `${did}#key-1`;
  return {
    "@context": ["https://www.w3.org/ns/did/v1"],
    id: did,
    verificationMethod: [{ id: method, type: "Ed25519VerificationKey2020", controller: did, publicKeyMultibase: publicKey }],
    authentication: [method],
    service: [],
  };
}

export function createDID(publicKey: string): SorokitResult<DIDData> {
  try {
    Keypair.fromPublicKey(publicKey);
    const did = `${DID_PREFIX}${publicKey}`;
    return ok({ did, publicKey, document: documentFor(did, publicKey) });
  } catch (cause) {
    return err(SorokitErrorCode.INVALID_ADDRESS, "Invalid Stellar public key", cause);
  }
}

export async function resolveDID(did: string): Promise<SorokitResult<DIDData>> {
  const parsed = parseDID(did);
  if (parsed.status === "error") return parsed;
  return ok(links.get(did) ?? { did, publicKey: parsed.data, document: documentFor(did, parsed.data) });
}

export async function linkAccountToDID(publicKey: string, did: string): Promise<SorokitResult<DIDData>> {
  const resolved = await resolveDID(did);
  if (resolved.status === "error") return resolved;
  if (resolved.data.publicKey !== publicKey) {
    return err(SorokitErrorCode.INVALID_AUTH, "DID does not identify the supplied Stellar account");
  }
  const linked = { ...resolved.data, linkedAt: new Date().toISOString() };
  links.set(did, linked);
  return ok(linked);
}

export async function verifyDIDOwnership(did: string, signature: string): Promise<SorokitResult<boolean>> {
  const resolved = await resolveDID(did);
  if (resolved.status === "error") return resolved;
  try {
    const verified = Keypair.fromPublicKey(resolved.data.publicKey).verify(
      Buffer.from(did, "utf8"),
      Buffer.from(signature, "base64"),
    );
    return ok(verified);
  } catch (cause) {
    return err(SorokitErrorCode.INVALID_AUTH, "Invalid DID ownership signature", cause);
  }
}

export function clearDIDLinks(): void { links.clear(); }
