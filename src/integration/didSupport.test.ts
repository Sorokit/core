import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { createDID, linkAccountToDID, resolveDID, verifyDIDOwnership } from "./didSupport";

describe("did:stellar support", () => {
  const pair = Keypair.random();
  const did = `did:stellar:${pair.publicKey()}`;

  it("creates and resolves a W3C DID document", async () => {
    expect(createDID(pair.publicKey())).toMatchObject({ status: "ok", data: { did } });
    const result = await resolveDID(did);
    expect(result).toMatchObject({ status: "ok", data: { publicKey: pair.publicKey(), document: { id: did } } });
  });

  it("links only the account encoded by the DID", async () => {
    expect(await linkAccountToDID(pair.publicKey(), did)).toMatchObject({ status: "ok" });
    expect(await linkAccountToDID(Keypair.random().publicKey(), did)).toMatchObject({ status: "error" });
  });

  it("verifies ownership signatures", async () => {
    const signature = pair.sign(Buffer.from(did, "utf8")).toString("base64");
    expect(await verifyDIDOwnership(did, signature)).toEqual({ status: "ok", data: true, error: null });
  });
});
