/**
 * @file didSupport.test.ts
 *
 * Comprehensive Vitest tests for the `src/integration/didSupport.ts` module.
 *
 * Test fixtures use the real testnet G-address:
 *   GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBWE3BDE54LQL
 *
 * No real network calls are made — custom resolvers return pre-built documents.
 */

import { describe, it, expect } from "vitest";
import {
  createDID,
  resolveDID,
  linkAccountToDID,
  verifyDIDOwnership,
  STELLAR_DID_METHOD,
} from "../integration/didSupport";
import type {
  StellarDIDDocument,
  DIDResolver,
  DIDOwnershipProof,
} from "../integration/didSupport";

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Real Stellar testnet address used throughout the test suite. */
const TEST_KEY = "GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBWE3BDE54LQL";
const TEST_DID = `did:stellar:${TEST_KEY}`;

/** A second distinct key for mismatch / cross-key tests.
 *  Must be a valid Stellar G-address (base32: A-Z and 2-7 only).
 */
const OTHER_KEY = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPGZRIXRYDFM6YTE4UJAE4AA7AR";
const OTHER_DID = `did:stellar:${OTHER_KEY}`;

/** A valid base64 string that stands in for a real Ed25519 signature. */
const MOCK_SIGNATURE = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

/** Pre-built DID document for TEST_KEY, used in resolver fakes. */
const PREBUILT_DOCUMENT: StellarDIDDocument = {
  "@context": [
    "https://www.w3.org/ns/did/v1",
    "https://w3id.org/security/suites/ed25519-2020/v1",
  ],
  id: TEST_DID,
  controller: TEST_DID,
  verificationMethod: [
    {
      id: `${TEST_DID}#key-1`,
      type: "StellarVerificationKey2024",
      controller: TEST_DID,
      publicKeyMultibase: TEST_KEY,
    },
  ],
  authentication: [`${TEST_DID}#key-1`],
  assertionMethod: [`${TEST_DID}#key-1`],
  created: "2026-01-01T00:00:00.000Z",
};

/** A DID document that is already expired. */
const EXPIRED_DOCUMENT: StellarDIDDocument = {
  ...PREBUILT_DOCUMENT,
  expires: "2020-01-01T00:00:00.000Z",
};

// ── Resolver factories ────────────────────────────────────────────────────────

/** Creates a resolver that always returns the provided document. */
function resolverReturning(doc: StellarDIDDocument | null): DIDResolver {
  return {
    async resolve(_did: string): Promise<StellarDIDDocument | null> {
      return doc;
    },
  };
}

/** Creates a resolver that always throws a network error. */
function resolverThrowing(message = "connection refused"): DIDResolver {
  return {
    async resolve(_did: string): Promise<never> {
      throw new Error(message);
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// createDID
// ═════════════════════════════════════════════════════════════════════════════

describe("createDID", () => {
  it("returns ok with correct DID format for a valid G-address", () => {
    const result = createDID(TEST_KEY);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return; // type narrowing

    expect(result.data.did).toBe(TEST_DID);
    expect(result.data.publicKey).toBe(TEST_KEY);
    expect(result.data.createdAt).toBeTruthy();
  });

  it("produces a DID with the did:stellar prefix", () => {
    const result = createDID(TEST_KEY);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    expect(result.data.did.startsWith(STELLAR_DID_METHOD + ":")).toBe(true);
  });

  it("returns the public key in the DIDInfo", () => {
    const result = createDID(TEST_KEY);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    expect(result.data.publicKey).toBe(TEST_KEY);
  });

  it("returns an error for an invalid address (empty string)", () => {
    const result = createDID("");

    expect(result.status).toBe("error");
    if (result.status !== "error") return;

    expect(result.error.code).toBe("INVALID_ADDRESS");
  });

  it("returns an error for an address that starts with the wrong letter", () => {
    const result = createDID("BAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBWE3BDE54LQL");

    expect(result.status).toBe("error");
    if (result.status !== "error") return;

    expect(result.error.code).toBe("INVALID_ADDRESS");
  });

  it("returns an error for an address that is too short", () => {
    const result = createDID("GSHORT");

    expect(result.status).toBe("error");
    if (result.status !== "error") return;

    expect(result.error.code).toBe("INVALID_ADDRESS");
  });

  it("generates a document with a StellarVerificationKey2024 verification method", () => {
    const result = createDID(TEST_KEY);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const { document } = result.data;
    expect(document.verificationMethod).toHaveLength(1);
    expect(document.verificationMethod[0].type).toBe("StellarVerificationKey2024");
    expect(document.verificationMethod[0].publicKeyMultibase).toBe(TEST_KEY);
  });

  it("generates a document with authentication and assertionMethod arrays", () => {
    const result = createDID(TEST_KEY);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const { document } = result.data;
    expect(document.authentication).toHaveLength(1);
    expect(document.assertionMethod).toHaveLength(1);
    expect(document.authentication[0]).toBe(`${TEST_DID}#key-1`);
    expect(document.assertionMethod[0]).toBe(`${TEST_DID}#key-1`);
  });

  it("embeds service endpoints when provided in options", () => {
    const services = [
      {
        id: `${TEST_DID}#federation`,
        type: "StellarFederationServer",
        serviceEndpoint: "https://stellar.org/federation",
      },
    ];
    const result = createDID(TEST_KEY, { services });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    expect(result.data.document.service).toHaveLength(1);
    expect(result.data.document.service?.[0].type).toBe("StellarFederationServer");
  });

  it("includes the W3C DID context in the document", () => {
    const result = createDID(TEST_KEY);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    expect(result.data.document["@context"]).toContain("https://www.w3.org/ns/did/v1");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// resolveDID
// ═════════════════════════════════════════════════════════════════════════════

describe("resolveDID", () => {
  it("self-resolves a did:stellar DID when no resolver is provided", async () => {
    const result = await resolveDID(TEST_DID);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    expect(result.data.id).toBe(TEST_DID);
    expect(result.data.verificationMethod[0].publicKeyMultibase).toBe(TEST_KEY);
  });

  it("self-resolution produces a StellarVerificationKey2024 method", async () => {
    const result = await resolveDID(TEST_DID);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    expect(result.data.verificationMethod[0].type).toBe("StellarVerificationKey2024");
  });

  it("returns the document from a custom resolver when one is provided", async () => {
    const result = await resolveDID(TEST_DID, { resolver: resolverReturning(PREBUILT_DOCUMENT) });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    expect(result.data).toEqual(PREBUILT_DOCUMENT);
  });

  it("returns an error when the custom resolver returns null", async () => {
    const result = await resolveDID(TEST_DID, { resolver: resolverReturning(null) });

    expect(result.status).toBe("error");
    if (result.status !== "error") return;

    expect(result.error.code).toBe("INVALID_CONFIG");
    expect(result.error.message).toContain("resolver returned no document");
  });

  it("returns a NETWORK_ERROR when the custom resolver throws", async () => {
    const result = await resolveDID(TEST_DID, { resolver: resolverThrowing() });

    expect(result.status).toBe("error");
    if (result.status !== "error") return;

    expect(result.error.code).toBe("NETWORK_ERROR");
  });

  it("returns INVALID_CONFIG for invalid DID syntax", async () => {
    const result = await resolveDID("not-a-did");

    expect(result.status).toBe("error");
    if (result.status !== "error") return;

    expect(result.error.code).toBe("INVALID_CONFIG");
  });

  it("returns INVALID_CONFIG for a non-stellar DID without a resolver", async () => {
    const result = await resolveDID("did:example:12345");

    expect(result.status).toBe("error");
    if (result.status !== "error") return;

    expect(result.error.code).toBe("INVALID_CONFIG");
    expect(result.error.message).toContain("no resolver was provided");
  });

  it("returns INVALID_CONFIG when a custom resolver returns an expired document", async () => {
    const result = await resolveDID(TEST_DID, { resolver: resolverReturning(EXPIRED_DOCUMENT) });

    expect(result.status).toBe("error");
    if (result.status !== "error") return;

    expect(result.error.code).toBe("INVALID_CONFIG");
    expect(result.error.message).toContain("expired");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// linkAccountToDID
// ═════════════════════════════════════════════════════════════════════════════

describe("linkAccountToDID", () => {
  it("returns ok with a DIDLinkRecord for a matching key and DID", async () => {
    const result = await linkAccountToDID(TEST_KEY, TEST_DID);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    expect(result.data.publicKey).toBe(TEST_KEY);
    expect(result.data.did).toBe(TEST_DID);
    expect(result.data.method).toBe(STELLAR_DID_METHOD);
    expect(result.data.linkedAt).toBeTruthy();
    expect(result.data.document.id).toBe(TEST_DID);
  });

  it("returns INVALID_ADDRESS for an invalid public key", async () => {
    const result = await linkAccountToDID("BADKEY", TEST_DID);

    expect(result.status).toBe("error");
    if (result.status !== "error") return;

    expect(result.error.code).toBe("INVALID_ADDRESS");
  });

  it("returns INVALID_CONFIG for an invalid DID string", async () => {
    const result = await linkAccountToDID(TEST_KEY, "not-a-did");

    expect(result.status).toBe("error");
    if (result.status !== "error") return;

    expect(result.error.code).toBe("INVALID_CONFIG");
  });

  it("returns INVALID_CONFIG when the key doesn't match the did:stellar key", async () => {
    // TEST_KEY linked to OTHER_DID — the embedded keys differ
    const result = await linkAccountToDID(TEST_KEY, OTHER_DID);

    expect(result.status).toBe("error");
    if (result.status !== "error") return;

    expect(result.error.code).toBe("INVALID_CONFIG");
    expect(result.error.message).toContain("mismatch");
  });

  it("uses a custom resolver to confirm the document and returns it", async () => {
    const result = await linkAccountToDID(TEST_KEY, TEST_DID, {
      resolver: resolverReturning(PREBUILT_DOCUMENT),
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    expect(result.data.document).toEqual(PREBUILT_DOCUMENT);
  });

  it("propagates resolver errors through linkAccountToDID", async () => {
    const result = await linkAccountToDID(TEST_KEY, TEST_DID, {
      resolver: resolverThrowing("registry down"),
    });

    expect(result.status).toBe("error");
    if (result.status !== "error") return;

    expect(result.error.code).toBe("NETWORK_ERROR");
    expect(result.error.message).toContain("resolution failed");
  });

  it("sets method to STELLAR_DID_METHOD constant", async () => {
    const result = await linkAccountToDID(TEST_KEY, TEST_DID);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    expect(result.data.method).toBe("did:stellar");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// verifyDIDOwnership
// ═════════════════════════════════════════════════════════════════════════════

describe("verifyDIDOwnership", () => {
  const validProof: DIDOwnershipProof = { signature: MOCK_SIGNATURE };

  it("returns verified=true for a valid proof structure with a key in the document", async () => {
    const result = await verifyDIDOwnership(TEST_DID, TEST_KEY, validProof);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    expect(result.data.verified).toBe(true);
    expect(result.data.did).toBe(TEST_DID);
    expect(result.data.publicKey).toBe(TEST_KEY);
  });

  it("exposes the canonical challenge in the result", async () => {
    const result = await verifyDIDOwnership(TEST_DID, TEST_KEY, validProof);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const expectedChallenge = `sorokit:did-ownership:${TEST_DID}:${TEST_KEY}`;
    expect(result.data.challenge).toBe(expectedChallenge);
  });

  it("returns an error when proof.signature is an empty string", async () => {
    const result = await verifyDIDOwnership(TEST_DID, TEST_KEY, { signature: "" });

    expect(result.status).toBe("error");
    if (result.status !== "error") return;

    expect(result.error.code).toBe("INVALID_AUTH");
    expect(result.error.message).toContain("missing a signature");
  });

  it("returns verified=false for a non-base64 signature", async () => {
    const result = await verifyDIDOwnership(TEST_DID, TEST_KEY, { signature: "!!!notbase64!!!" });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    expect(result.data.verified).toBe(false);
    expect(result.data.reason).toContain("not valid base64");
  });

  it("returns verified=false when the public key is not in the document", async () => {
    // Use OTHER_KEY but a resolver that returns TEST_KEY's document
    // (which does NOT contain OTHER_KEY in verificationMethod)
    const result = await verifyDIDOwnership(
      TEST_DID,
      OTHER_KEY, // key not listed in the document for TEST_DID
      validProof,
      // Provide a resolver that returns the prebuilt document for TEST_DID
      { resolver: resolverReturning(PREBUILT_DOCUMENT) },
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    expect(result.data.verified).toBe(false);
    expect(result.data.reason).toContain("not listed in the verification methods");
  });

  it("returns INVALID_ADDRESS for an invalid public key", async () => {
    const result = await verifyDIDOwnership(TEST_DID, "BADKEY", validProof);

    expect(result.status).toBe("error");
    if (result.status !== "error") return;

    expect(result.error.code).toBe("INVALID_ADDRESS");
  });

  it("returns INVALID_CONFIG for an invalid DID", async () => {
    const result = await verifyDIDOwnership("not-a-did", TEST_KEY, validProof);

    expect(result.status).toBe("error");
    if (result.status !== "error") return;

    expect(result.error.code).toBe("INVALID_CONFIG");
  });

  it("returns a network error when the resolver throws during verification", async () => {
    const result = await verifyDIDOwnership(TEST_DID, TEST_KEY, validProof, {
      resolver: resolverThrowing("DID registry unreachable"),
    });

    expect(result.status).toBe("error");
    if (result.status !== "error") return;

    expect(result.error.code).toBe("NETWORK_ERROR");
  });

  it("includes the document in the result when verification succeeds", async () => {
    const result = await verifyDIDOwnership(TEST_DID, TEST_KEY, validProof, {
      resolver: resolverReturning(PREBUILT_DOCUMENT),
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    expect(result.data.document).toEqual(PREBUILT_DOCUMENT);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// STELLAR_DID_METHOD constant
// ═════════════════════════════════════════════════════════════════════════════

describe("STELLAR_DID_METHOD", () => {
  it("equals 'did:stellar'", () => {
    expect(STELLAR_DID_METHOD).toBe("did:stellar");
  });

  it("is used as the prefix for DIDs created by createDID", () => {
    const result = createDID(TEST_KEY);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    expect(result.data.did.startsWith(STELLAR_DID_METHOD + ":")).toBe(true);
  });
});
